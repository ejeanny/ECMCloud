import { Prisma, prisma } from '@ecm/db';
import type { RestrictionClause, FieldType } from '@ecm/domain';
import { compileClauses, fieldsFor, setIndexValues } from './index-values.js';

/**
 * Workflow engine.
 *
 * Reconstructs the behaviour implied by Dokmee's 23 per-cabinet workflow
 * tables (§4): a workflow has design revisions, one of which is published;
 * a trigger fires on new documents or index changes, narrowed by criteria;
 * a published revision has tasks and routings; and an instance walks the
 * routings one task at a time, creating to-dos for the assignees of each.
 *
 * Dokmee's `Workflow_Tasks.Type` and `Workflow_Routings.Type` integers were
 * not recovered, so the vocabulary here is our own (domain/enums.ts).
 */

export interface AdvanceResult {
  readonly state: 'running' | 'completed' | 'error';
  readonly taskKey: string | null;
}

/** Starts an instance of a workflow's published revision against one node. */
export async function startInstance(
  tx: Prisma.TransactionClient,
  workflowId: string,
  nodeId: string,
): Promise<string | null> {
  const workflow = await tx.workflow.findUnique({
    where: { id: workflowId },
    include: {
      versions: {
        where: { published: true },
        include: { tasks: true, routings: { orderBy: { order: 'asc' } } },
        take: 1,
      },
    },
  });

  const version = workflow?.versions[0];
  if (!workflow || !version || version.tasks.length === 0) return null;

  // An instance already running for this node and workflow is not restarted;
  // Dokmee's `WorkflowActiveInstances` is keyed the same way.
  const existing = await tx.workflowInstance.findFirst({
    where: { workflowId, nodeId, state: 'running' },
    select: { id: true },
  });
  if (existing) return existing.id;

  const firstKey = firstTaskKey(version.tasks, version.routings, version.entryTaskKey);
  if (!firstKey) return null;

  const instance = await tx.workflowInstance.create({
    data: {
      workflowId,
      versionId: version.id,
      nodeId,
      state: 'running',
      currentTaskKey: firstKey,
    },
  });

  await enterTask(tx, instance.id, version.id, firstKey);
  return instance.id;
}

/**
 * The entry task is the one nothing routes *to*. If every task is a routing
 * target the design is cyclic with no entry, which is a design error rather
 * than something to guess around.
 */
/**
 * Where an instance starts.
 *
 * A declared entry wins. Otherwise it is inferred as the first task nothing
 * routes to — which is right for a straight line, and wrong as soon as a
 * rejection loops back to the first reviewer, because then every task has an
 * incoming edge. That is why the entry can be declared.
 */
export function firstTaskKey(
  tasks: ReadonlyArray<{ key: string }>,
  routings: ReadonlyArray<{ toTaskKey: string | null }>,
  entryTaskKey?: string | null,
): string | null {
  if (entryTaskKey && tasks.some((t) => t.key === entryTaskKey)) return entryTaskKey;
  const targets = new Set(routings.map((r) => r.toTaskKey).filter((k): k is string => k !== null));
  return tasks.find((t) => !targets.has(t.key))?.key ?? null;
}

/** Creates one to-do per assignee of the task, or one unassigned to-do. */
type TaskRow = Prisma.WorkflowTaskGetPayload<{ include: { assignees: true } }>;

/** The users a task is addressed to: its named users plus its roles' members. */
async function audienceOf(
  tx: Prisma.TransactionClient,
  task: TaskRow,
): Promise<Set<string>> {
  const userIds = new Set<string>();
  for (const a of task.assignees) {
    if (a.userId) userIds.add(a.userId);
  }

  const roleIds = task.assignees
    .map((a) => a.roleId)
    .filter((id): id is string => id !== null);

  if (roleIds.length > 0) {
    const members = await tx.userRole.findMany({
      where: { roleId: { in: roleIds } },
      select: { userId: true },
    });
    for (const m of members) userIds.add(m.userId);
  }
  return userIds;
}

async function createTodos(
  tx: Prisma.TransactionClient,
  instanceId: string,
  task: TaskRow,
): Promise<void> {
  const userIds = await audienceOf(tx, task);

  if (userIds.size === 0) {
    await tx.workflowTodo.create({
      data: { instanceId, taskId: task.id, assignedToId: null },
    });
    return;
  }

  await tx.workflowTodo.createMany({
    data: [...userIds].map((userId) => ({
      instanceId,
      taskId: task.id,
      assignedToId: userId,
    })),
  });

  const instance = await tx.workflowInstance.findUnique({
    where: { id: instanceId },
    select: { node: { select: { name: true, cabinetId: true } } },
  });

  await tx.notification.createMany({
    data: [...userIds].map((userId) => ({
      userId,
      type: 'workflow',
      action: 'assigned',
      message: `"${task.name}" is waiting on you for ${instance?.node.name ?? 'a document'}.`,
      entityId: instanceId,
      cabinetId: instance?.node.cabinetId ?? null,
    })),
  });
}

/**
 * Completes the current task and moves to the next. A task is complete when
 * one to-do is answered; Dokmee's `AllowSpecificReviewer` flag distinguishes
 * "anyone on the role" from "this named reviewer", and either way one answer
 * decides the step.
 */
/** The task types that wait for a person. Everything else the engine runs. */
const HUMAN_TASKS = new Set(['review', 'approval', 'decision']);

/**
 * Task types that need something this rebuild does not ship. An instance
 * reaching one stops in `error` saying which engine is missing, rather than
 * sitting in a to-do list forever waiting for a person who cannot help.
 */
const NEEDS_ENGINE: Record<string, string> = {
  stamp: 'needs the stamp subsystem — Dokmee burned a stored image with Apryse',
  signature: 'needs a signing provider; Dokmee used DocuSign',
  email: 'needs an SMTP transport',
  rpa: 'needs the RPA runner',
  clone: 'needs a copy target, which the recovered task config does not carry',
};

/** A chain of automatic steps longer than this is a loop, not a design. */
const AUTOMATIC_STEP_LIMIT = 50;

/** Which routing out of a task is taken, given how the step was answered. */
function nextFrom(
  routings: ReadonlyArray<{ type: string; decision: string | null; toTaskKey: string | null }>,
  decision: 'approve' | 'reject' | 'choose',
  choice: string | null,
) {
  return (
    routings.find((r) => {
      if (decision === 'choose') return r.type === 'onDecision' && r.decision === choice;
      if (decision === 'reject') return r.type === 'onReject';
      return r.type === 'onApprove';
    }) ?? routings.find((r) => r.type === 'always')
  );
}

async function complete(
  tx: Prisma.TransactionClient,
  instanceId: string,
): Promise<AdvanceResult> {
  await tx.workflowInstance.update({
    where: { id: instanceId },
    data: { state: 'completed', currentTaskKey: null, finished: new Date() },
  });
  return { state: 'completed', taskKey: null };
}

async function halt(
  tx: Prisma.TransactionClient,
  instanceId: string,
  reason: string,
): Promise<AdvanceResult> {
  await tx.workflowInstance.update({
    where: { id: instanceId },
    data: { state: 'error', error: reason, finished: new Date() },
  });
  return { state: 'error', taskKey: null };
}

/** `notify`: tell the task's audience, then carry on without waiting. */
async function runNotify(
  tx: Prisma.TransactionClient,
  instanceId: string,
  task: TaskRow,
): Promise<void> {
  const instance = await tx.workflowInstance.findUniqueOrThrow({
    where: { id: instanceId },
    select: {
      node: { select: { id: true, name: true, cabinetId: true, createdById: true } },
    },
  });

  const config = task.config as { message?: unknown } | null;
  const message =
    typeof config?.message === 'string' && config.message.trim()
      ? config.message
      : `"${task.name}" ran on ${instance.node.name}.`;

  const audience = await audienceOf(tx, task);
  // Addressed to nobody in particular, so tell whoever filed the document —
  // a notification step that notifies no one is a step that does nothing.
  if (audience.size === 0 && instance.node.createdById) {
    audience.add(instance.node.createdById);
  }
  if (audience.size === 0) return;

  await tx.notification.createMany({
    data: [...audience].map((userId) => ({
      userId,
      type: 'workflow',
      action: 'notified',
      message,
      entityId: instanceId,
      cabinetId: instance.node.cabinetId,
    })),
  });
}

/** `updateIndex`: write the values named on the task, then carry on. */
async function runUpdateIndex(
  tx: Prisma.TransactionClient,
  instanceId: string,
  task: TaskRow,
): Promise<string | null> {
  const config = task.config as { values?: unknown } | null;
  const raw = Array.isArray(config?.values) ? config.values : null;
  if (!raw || raw.length === 0) {
    return `"${task.name}" is an update-index step with no values configured.`;
  }

  const values = raw.filter(
    (v): v is { fieldId: string; value: unknown } =>
      typeof v === 'object' && v !== null && typeof (v as { fieldId?: unknown }).fieldId === 'string',
  );
  if (values.length !== raw.length) {
    return `"${task.name}" has an update-index value with no field.`;
  }

  const instance = await tx.workflowInstance.findUniqueOrThrow({
    where: { id: instanceId },
    select: { node: { select: { id: true, cabinetId: true } } },
  });

  try {
    // The helper, not the router's mutation: this writes no `workflowTrigger`
    // job, so a workflow that sets an index value cannot re-trigger itself.
    // `allowLocked` because a locked field is exactly the kind a workflow owns
    // and a user must not edit by hand.
    await setIndexValues(tx, instance.node.cabinetId, instance.node.id, values as never, {
      allowLocked: true,
    });
  } catch (error) {
    return `"${task.name}" could not write its index values: ${
      error instanceof Error ? error.message : String(error)
    }`;
  }
  return null;
}

/**
 * Enter a task: run it if the engine owns it, or wait if a person does.
 *
 * Without this every task type created a to-do and waited, so a `notify` step
 * sat in someone's inbox instead of notifying them and an `end` step never
 * ended anything. Automatic steps chain until the flow reaches one that waits,
 * finishes, or fails.
 */
async function enterTask(
  tx: Prisma.TransactionClient,
  instanceId: string,
  versionId: string,
  startKey: string,
): Promise<AdvanceResult> {
  let key: string | null = startKey;

  for (let step = 0; step < AUTOMATIC_STEP_LIMIT; step += 1) {
    if (!key) return complete(tx, instanceId);

    const task: TaskRow | null = await tx.workflowTask.findFirst({
      where: { versionId, key },
      include: { assignees: true },
    });
    if (!task) {
      return halt(tx, instanceId, `The design has no task "${key}".`);
    }

    if (HUMAN_TASKS.has(task.type)) {
      await tx.workflowInstance.update({
        where: { id: instanceId },
        data: { currentTaskKey: key },
      });
      await createTodos(tx, instanceId, task);
      return { state: 'running', taskKey: key };
    }

    if (task.type === 'end') return complete(tx, instanceId);

    const missing = NEEDS_ENGINE[task.type];
    if (missing) return halt(tx, instanceId, `"${task.name}" ${missing}.`);

    if (task.type === 'notify') {
      await runNotify(tx, instanceId, task);
    } else if (task.type === 'updateIndex') {
      const problem = await runUpdateIndex(tx, instanceId, task);
      if (problem) return halt(tx, instanceId, problem);
    } else {
      return halt(tx, instanceId, `No handler for task type "${task.type}".`);
    }

    // An automatic step answers itself, so it leaves by the approve path.
    const routings = await tx.workflowRouting.findMany({
      where: { versionId, fromTaskKey: key },
      orderBy: { order: 'asc' },
    });
    const next = nextFrom(routings, 'approve', null);
    if (!next || next.toTaskKey === null) return complete(tx, instanceId);
    key = next.toTaskKey;
  }

  return halt(
    tx,
    instanceId,
    `Stopped after ${AUTOMATIC_STEP_LIMIT} automatic steps without reaching one that waits — the design loops.`,
  );
}

export async function advance(
  tx: Prisma.TransactionClient,
  instanceId: string,
  decision: 'approve' | 'reject' | 'choose',
  choice: string | null,
): Promise<AdvanceResult> {
  const instance = await tx.workflowInstance.findUnique({
    where: { id: instanceId },
    include: {
      version: { include: { routings: { orderBy: { order: 'asc' } }, tasks: true } },
    },
  });
  if (!instance || instance.state !== 'running' || !instance.currentTaskKey) {
    return { state: 'error', taskKey: null };
  }

  const routings = instance.version.routings.filter(
    (r) => r.fromTaskKey === instance.currentTaskKey,
  );
  const next = nextFrom(routings, decision, choice);

  // No matching routing ends the instance; a rejection with no reject edge
  // completes rather than stalling, which is what "no further step" means.
  if (!next || next.toTaskKey === null) return complete(tx, instanceId);

  return enterTask(tx, instanceId, instance.versionId, next.toTaskKey);
}

/**
 * Fires every published workflow in the cabinet whose trigger matches the
 * node. Called after a document is created or its index values change, which
 * is what Dokmee's `IsNewDoc` / `IsIndexChanged` trigger flags select.
 */
export async function fireTriggers(
  cabinetId: string,
  nodeId: string,
  event: 'newDocument' | 'indexChanged',
): Promise<string[]> {
  const versions = await prisma.workflowVersion.findMany({
    where: {
      published: true,
      workflow: { cabinetId, inError: false },
      ...(event === 'newDocument' ? { onNewDocument: true } : { onIndexChanged: true }),
    },
    select: {
      id: true,
      workflowId: true,
      triggerCombine: true,
      triggerClauses: true,
    },
  });
  if (versions.length === 0) return [];

  const fields = await fieldsFor(cabinetId);
  const typeById = new Map<string, FieldType>(fields.map((f) => [f.id, f.type]));
  const started: string[] = [];

  for (const version of versions) {
    const clauses = version.triggerClauses as unknown as RestrictionClause[];
    const compiled = compileClauses(
      clauses,
      typeById,
      version.triggerCombine === 'or' ? 'or' : 'and',
    );

    const matches = await prisma.node.count({
      where: { id: nodeId, ...(compiled ?? {}) },
    });
    if (matches === 0) continue;

    const instanceId = await prisma.$transaction((tx) =>
      startInstance(tx, version.workflowId, nodeId),
    );
    if (instanceId) started.push(instanceId);
  }

  return started;
}
