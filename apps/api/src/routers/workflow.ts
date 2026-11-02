import { z } from 'zod';
import { prisma } from '@ecm/db';
import { completeTodoInput, pageInput, saveWorkflowInput, startWorkflowInput } from '@ecm/domain';
import { audit } from '../audit.js';
import {
  assertCanEnter,
  badRequest,
  cabinetRight,
  conflict,
  notFound,
  protectedProcedure,
  router,
} from '../trpc.js';
import { advance, startInstance } from '../workflow-engine.js';

/**
 * Dokmee: WorkflowController / GlobalWorkflowController, over the per-cabinet
 * workflow tables and the master `WorkflowActiveInstances` (§4).
 *
 * Design edits create a new revision; `publish` promotes one. Dokmee's
 * `IsLocked` / `LockedBy` design lock is kept so two designers cannot
 * overwrite each other.
 */
export const workflowRouter = router({
  list: protectedProcedure
    .input(z.object({ cabinetId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      assertCanEnter(ctx.principal, input.cabinetId);
      const workflows = await prisma.workflow.findMany({
        where: { cabinetId: input.cabinetId },
        orderBy: { name: 'asc' },
        include: {
          versions: {
            select: { id: true, revision: true, published: true, created: true },
            orderBy: { revision: 'desc' },
          },
          _count: { select: { instances: true } },
        },
      });

      return workflows.map((w) => ({
        id: w.id,
        name: w.name,
        description: w.description,
        inError: w.inError,
        isLocked: w.isLocked,
        lockedById: w.lockedById,
        revisions: w.versions,
        publishedRevision: w.versions.find((v) => v.published)?.revision ?? null,
        instanceCount: w._count.instances,
      }));
    }),

  byId: protectedProcedure
    .input(z.object({ workflowId: z.string().uuid(), revision: z.number().int().optional() }))
    .query(async ({ ctx, input }) => {
      const workflow = await prisma.workflow.findUnique({
        where: { id: input.workflowId },
      });
      if (!workflow) notFound('Workflow');
      assertCanEnter(ctx.principal, workflow.cabinetId);

      const version = await prisma.workflowVersion.findFirst({
        where: {
          workflowId: workflow.id,
          ...(input.revision === undefined ? {} : { revision: input.revision }),
        },
        orderBy: { revision: 'desc' },
        include: {
          tasks: { include: { assignees: true }, orderBy: { created: 'asc' } },
          routings: { orderBy: { order: 'asc' } },
        },
      });
      if (!version) notFound('Workflow revision');

      return {
        workflow: {
          id: workflow.id,
          cabinetId: workflow.cabinetId,
          name: workflow.name,
          description: workflow.description,
          inError: workflow.inError,
        },
        revision: version.revision,
        published: version.published,
        trigger: {
          onNewDocument: version.onNewDocument,
          onIndexChanged: version.onIndexChanged,
          combine: version.triggerCombine,
          clauses: version.triggerClauses,
        },
        tasks: version.tasks.map((t) => ({
          key: t.key,
          name: t.name,
          type: t.type,
          allowSpecificReviewer: t.allowSpecificReviewer,
          config: t.config,
          assigneeRoleIds: t.assignees.flatMap((a) => (a.roleId ? [a.roleId] : [])),
          assigneeUserIds: t.assignees.flatMap((a) => (a.userId ? [a.userId] : [])),
        })),
        routings: version.routings.map((r) => ({
          fromTaskKey: r.fromTaskKey,
          toTaskKey: r.toTaskKey,
          type: r.type,
          decision: r.decision,
          order: r.order,
        })),
      };
    }),

  /** Saving always creates a new revision; published revisions stay immutable. */
  save: cabinetRight('Workflow_Management')
    .input(saveWorkflowInput)
    .mutation(async ({ ctx, input }) => {
      const taskKeys = new Set(input.tasks.map((t) => t.key));
      if (taskKeys.size !== input.tasks.length) {
        badRequest('Task keys must be unique within a workflow.');
      }
      for (const r of input.routings) {
        if (!taskKeys.has(r.fromTaskKey)) {
          badRequest(`Routing references unknown task "${r.fromTaskKey}".`);
        }
        if (r.toTaskKey !== null && !taskKeys.has(r.toTaskKey)) {
          badRequest(`Routing references unknown task "${r.toTaskKey}".`);
        }
      }

      const result = await prisma.$transaction(async (tx) => {
        let workflowId = input.workflowId;

        if (workflowId) {
          const existing = await tx.workflow.findUnique({ where: { id: workflowId } });
          if (!existing) notFound('Workflow');
          if (
            existing.isLocked &&
            existing.lockedById !== ctx.principal.userId &&
            !ctx.principal.isAdministrator
          ) {
            conflict('Workflow is locked by another designer.');
          }
          await tx.workflow.update({
            where: { id: workflowId },
            data: { name: input.name, description: input.description },
          });
        } else {
          const created = await tx.workflow.create({
            data: {
              cabinetId: input.cabinetId,
              name: input.name,
              description: input.description,
            },
          });
          workflowId = created.id;
        }

        const last = await tx.workflowVersion.findFirst({
          where: { workflowId },
          orderBy: { revision: 'desc' },
          select: { revision: true },
        });

        const version = await tx.workflowVersion.create({
          data: {
            workflowId,
            revision: (last?.revision ?? 0) + 1,
            onNewDocument: input.trigger.onNewDocument,
            onIndexChanged: input.trigger.onIndexChanged,
            triggerCombine: input.trigger.combine,
            triggerClauses: input.trigger.clauses as never,
          },
        });

        for (const task of input.tasks) {
          await tx.workflowTask.create({
            data: {
              versionId: version.id,
              key: task.key,
              name: task.name,
              type: task.type,
              allowSpecificReviewer: task.allowSpecificReviewer,
              config: task.config as never,
              assignees: {
                create: [
                  ...task.assigneeRoleIds.map((roleId) => ({ roleId })),
                  ...task.assigneeUserIds.map((userId) => ({ userId })),
                ],
              },
            },
          });
        }

        await tx.workflowRouting.createMany({
          data: input.routings.map((r) => ({
            versionId: version.id,
            fromTaskKey: r.fromTaskKey,
            toTaskKey: r.toTaskKey,
            type: r.type,
            order: r.order,
          })),
        });

        return { workflowId, revision: version.revision, versionId: version.id };
      });

      await audit(ctx.principal, ctx.ip, {
        action: input.workflowId ? 'update' : 'create',
        cabinetId: input.cabinetId,
        detail: { what: 'workflow', name: input.name, revision: result.revision },
      });
      return result;
    }),

  publish: cabinetRight('Workflow_Management')
    .input(
      z.object({
        cabinetId: z.string().uuid(),
        workflowId: z.string().uuid(),
        revision: z.number().int().min(1),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const version = await prisma.workflowVersion.findFirst({
        where: { workflowId: input.workflowId, revision: input.revision },
        include: { tasks: { select: { key: true } }, routings: true, workflow: true },
      });
      if (!version) notFound('Workflow revision');
      if (version.workflow.cabinetId !== input.cabinetId) notFound('Workflow revision');
      if (version.tasks.length === 0) badRequest('A workflow needs at least one task.');

      const targets = new Set(
        version.routings.flatMap((r) => (r.toTaskKey ? [r.toTaskKey] : [])),
      );
      if (!version.tasks.some((t) => !targets.has(t.key))) {
        badRequest('No entry task: every task is the target of a routing.');
      }

      await prisma.$transaction([
        prisma.workflowVersion.updateMany({
          where: { workflowId: input.workflowId, published: true },
          data: { published: false },
        }),
        prisma.workflowVersion.update({
          where: { id: version.id },
          data: { published: true },
        }),
        prisma.workflow.update({
          where: { id: input.workflowId },
          data: { publishedVersionId: version.id, inError: false },
        }),
      ]);

      await audit(ctx.principal, ctx.ip, {
        action: 'update',
        cabinetId: input.cabinetId,
        detail: { what: 'workflowPublish', name: version.workflow.name, revision: input.revision },
      });
      return { ok: true };
    }),

  setLock: cabinetRight('Workflow_Management')
    .input(
      z.object({
        cabinetId: z.string().uuid(),
        workflowId: z.string().uuid(),
        locked: z.boolean(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const workflow = await prisma.workflow.findUnique({ where: { id: input.workflowId } });
      if (!workflow) notFound('Workflow');
      if (
        workflow.isLocked &&
        workflow.lockedById !== ctx.principal.userId &&
        !ctx.principal.isAdministrator
      ) {
        conflict('Locked by another designer.');
      }

      await prisma.workflow.update({
        where: { id: input.workflowId },
        data: input.locked
          ? { isLocked: true, lockedById: ctx.principal.userId, lockedAt: new Date() }
          : { isLocked: false, lockedById: null, lockedAt: null },
      });
      return { ok: true };
    }),

  /** Manual start, alongside the trigger-driven path in workflow-engine.ts. */
  start: cabinetRight('Workflow_Management')
    .input(startWorkflowInput.extend({ cabinetId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const started: string[] = [];
      for (const nodeId of input.nodeIds) {
        const instanceId = await prisma.$transaction((tx) =>
          startInstance(tx, input.workflowId, nodeId),
        );
        if (instanceId) started.push(instanceId);
      }
      if (started.length === 0) {
        badRequest('Nothing started: the workflow has no published revision with tasks.');
      }

      await audit(ctx.principal, ctx.ip, {
        action: 'create',
        cabinetId: input.cabinetId,
        detail: { what: 'workflowInstances', count: started.length },
      });
      return { instanceIds: started };
    }),

  /** The caller's inbox — Dokmee's `Workflow_Instance_Todo`. */
  myTodos: protectedProcedure.input(pageInput).query(async ({ ctx, input }) => {
    const where = {
      state: 'open',
      OR: [{ assignedToId: ctx.principal.userId }, { assignedToId: null }],
    };

    const [items, total] = await Promise.all([
      prisma.workflowTodo.findMany({
        where,
        orderBy: { created: 'asc' },
        skip: input.skip,
        take: input.take,
        include: {
          task: { select: { name: true, type: true, config: true } },
          instance: {
            select: {
              id: true,
              started: true,
              workflow: { select: { id: true, name: true, cabinetId: true } },
              node: { select: { id: true, name: true, ext: true } },
            },
          },
        },
      }),
      prisma.workflowTodo.count({ where }),
    ]);

    return {
      items: items.filter(
        (t) => !ctx.principal.deniedCabinets.has(t.instance.workflow.cabinetId),
      ),
      total,
    };
  }),

  completeTodo: protectedProcedure
    .input(completeTodoInput)
    .mutation(async ({ ctx, input }) => {
      const todo = await prisma.workflowTodo.findUnique({
        where: { id: input.todoId },
        include: {
          instance: { select: { id: true, state: true, workflow: { select: { cabinetId: true } } } },
        },
      });
      if (!todo) notFound('Task');
      if (todo.state !== 'open') conflict('Task is already completed.');
      if (todo.assignedToId && todo.assignedToId !== ctx.principal.userId && !ctx.principal.isAdministrator) {
        conflict('Task is assigned to another user.');
      }
      if (todo.instance.state !== 'running') conflict('Workflow instance is not running.');
      if (input.decision === 'choose' && !input.choice) {
        badRequest('A decision task needs a choice.');
      }

      const result = await prisma.$transaction(async (tx) => {
        await tx.workflowTodo.update({
          where: { id: todo.id },
          data: {
            state: 'done',
            decision: input.decision === 'choose' ? input.choice : input.decision,
            comment: input.comment ?? null,
            completed: new Date(),
            assignedToId: todo.assignedToId ?? ctx.principal.userId,
          },
        });

        // Sibling to-dos for the same step are superseded by this answer.
        await tx.workflowTodo.updateMany({
          where: {
            instanceId: todo.instanceId,
            taskId: todo.taskId,
            state: 'open',
            id: { not: todo.id },
          },
          data: { state: 'skipped', completed: new Date() },
        });

        return advance(tx, todo.instanceId, input.decision, input.choice ?? null);
      });

      await audit(ctx.principal, ctx.ip, {
        action: 'update',
        cabinetId: todo.instance.workflow.cabinetId,
        detail: {
          what: 'workflowTodo',
          decision: input.decision,
          nextTask: result.taskKey,
          instanceState: result.state,
        },
      });
      return result;
    }),

  /** Instance history for one document — the audit trail a reviewer asks for. */
  instancesForNode: protectedProcedure
    .input(z.object({ nodeId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const node = await prisma.node.findUnique({
        where: { id: input.nodeId },
        select: { cabinetId: true },
      });
      if (!node) notFound('Document');
      assertCanEnter(ctx.principal, node.cabinetId);

      return prisma.workflowInstance.findMany({
        where: { nodeId: input.nodeId },
        orderBy: { started: 'desc' },
        include: {
          workflow: { select: { name: true } },
          todos: {
            orderBy: { created: 'asc' },
            include: {
              task: { select: { name: true, type: true } },
              assignedTo: { select: { userName: true } },
            },
          },
        },
      });
    }),

  cancelInstance: cabinetRight('Workflow_Management')
    .input(z.object({ cabinetId: z.string().uuid(), instanceId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      await prisma.$transaction([
        prisma.workflowTodo.updateMany({
          where: { instanceId: input.instanceId, state: 'open' },
          data: { state: 'skipped', completed: new Date() },
        }),
        prisma.workflowInstance.update({
          where: { id: input.instanceId },
          data: { state: 'cancelled', currentTaskKey: null, finished: new Date() },
        }),
      ]);
      await audit(ctx.principal, ctx.ip, {
        action: 'update',
        cabinetId: input.cabinetId,
        detail: { what: 'workflowCancel', instanceId: input.instanceId },
      });
      return { ok: true };
    }),
});
