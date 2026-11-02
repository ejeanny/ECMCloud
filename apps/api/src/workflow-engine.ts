import { Prisma, prisma } from '@ecm/db';
import type { RestrictionClause, FieldType } from '@ecm/domain';
import { compileClauses, fieldsFor } from './index-values.js';

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

  await createTodos(tx, instance.id, version.id, firstKey);
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
async function createTodos(
  tx: Prisma.TransactionClient,
  instanceId: string,
  versionId: string,
  taskKey: string,
): Promise<void> {
  const task = await tx.workflowTask.findFirst({
    where: { versionId, key: taskKey },
    include: { assignees: true },
  });
  if (!task) return;

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

  const next =
    routings.find((r) => {
      if (decision === 'choose') return r.type === 'onDecision' && r.decision === choice;
      if (decision === 'reject') return r.type === 'onReject';
      return r.type === 'onApprove';
    }) ?? routings.find((r) => r.type === 'always');

  // No matching routing ends the instance; a rejection with no reject edge
  // completes rather than stalling, which is what "no further step" means.
  if (!next || next.toTaskKey === null) {
    await tx.workflowInstance.update({
      where: { id: instanceId },
      data: { state: 'completed', currentTaskKey: null, finished: new Date() },
    });
    return { state: 'completed', taskKey: null };
  }

  await tx.workflowInstance.update({
    where: { id: instanceId },
    data: { currentTaskKey: next.toTaskKey },
  });
  await createTodos(tx, instanceId, instance.versionId, next.toTaskKey);

  return { state: 'running', taskKey: next.toTaskKey };
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
