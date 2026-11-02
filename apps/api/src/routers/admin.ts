import { z } from 'zod';
import { Prisma, prisma } from '@ecm/db';
import {
  auditQueryInput,
  enqueueJobInput,
  notificationQueryInput,
  retentionJobInput,
  type RestrictionClause,
  type FieldType,
} from '@ecm/domain';
import { audit } from '../audit.js';
import { compileClauses, fieldsFor } from '../index-values.js';
import {
  adminProcedure,
  badRequest,
  cabinetRight,
  notFound,
  protectedProcedure,
  router,
  systemRight,
} from '../trpc.js';

/**
 * Audit, retention, notifications and the job queue.
 *
 * Dokmee: AuditController, RetentionController (`Retention_Job` and the
 * Retention service), UserNotificationController (`User_Notification`), and
 * the ten queue tables its out-of-process services drained (§2, §4).
 */

export const auditRouter = router({
  query: systemRight('View_Audit_Log')
    .input(auditQueryInput)
    .query(async ({ input }) => {
      const where: Prisma.AuditRecordWhereInput = {
        ...(input.cabinetId ? { cabinetId: input.cabinetId } : {}),
        ...(input.userId ? { userId: input.userId } : {}),
        ...(input.nodeId ? { nodeId: input.nodeId } : {}),
        ...(input.actions?.length ? { action: { in: [...input.actions] } } : {}),
        ...(input.from || input.to
          ? {
              at: {
                ...(input.from ? { gte: input.from } : {}),
                ...(input.to ? { lte: input.to } : {}),
              },
            }
          : {}),
      };

      const [items, total] = await Promise.all([
        prisma.auditRecord.findMany({
          where,
          orderBy: { at: 'desc' },
          skip: input.skip,
          take: input.take,
        }),
        prisma.auditRecord.count({ where }),
      ]);
      return { items, total };
    }),

  /** Dokmee: Export_Audit_Log. */
  exportRows: systemRight('Export_Audit_Log')
    .input(auditQueryInput.extend({ take: z.number().int().min(1).max(100_000).default(10_000) }))
    .query(async ({ ctx, input }) => {
      const rows = await prisma.auditRecord.findMany({
        where: {
          ...(input.cabinetId ? { cabinetId: input.cabinetId } : {}),
          ...(input.actions?.length ? { action: { in: [...input.actions] } } : {}),
          ...(input.from || input.to
            ? {
                at: {
                  ...(input.from ? { gte: input.from } : {}),
                  ...(input.to ? { lte: input.to } : {}),
                },
              }
            : {}),
        },
        orderBy: { at: 'desc' },
        take: input.take,
      });

      await audit(ctx.principal, ctx.ip, {
        action: 'export',
        detail: { what: 'auditLog', rows: rows.length },
      });
      return { rows, truncated: rows.length === input.take };
    }),

  /** Event counts per day, for the activity chart. */
  activity: systemRight('View_Audit_Log')
    .input(
      z.object({
        cabinetId: z.string().uuid().optional(),
        days: z.number().int().min(1).max(365).default(30),
      }),
    )
    .query(async ({ input }) => {
      const since = new Date(Date.now() - input.days * 86_400_000);
      const rows = await prisma.$queryRaw<Array<{ day: Date; action: string; count: bigint }>>`
        SELECT date_trunc('day', "at") AS day, "action", COUNT(*) AS count
        FROM "audit_record"
        WHERE "at" >= ${since}
          AND (${input.cabinetId ?? null}::uuid IS NULL OR "cabinetId" = ${input.cabinetId ?? null}::uuid)
        GROUP BY 1, 2
        ORDER BY 1 ASC
      `;
      return rows.map((r) => ({ day: r.day, action: r.action, count: Number(r.count) }));
    }),
});

export const retentionRouter = router({
  list: cabinetRight('File_Retention_Manage_Settings')
    .input(z.object({ cabinetId: z.string().uuid() }))
    .query(async ({ input }) =>
      prisma.retentionJob.findMany({
        where: { cabinetId: input.cabinetId },
        orderBy: { name: 'asc' },
      }),
    ),

  save: cabinetRight('File_Retention_Manage_Settings')
    .input(retentionJobInput.extend({ jobId: z.string().uuid().optional() }))
    .mutation(async ({ ctx, input }) => {
      const { jobId, clauses, combine, ...data } = input;
      if (data.years === 0 && data.months === 0 && data.days === 0) {
        badRequest('A retention period of zero would expire every document immediately.');
      }

      const job = jobId
        ? await prisma.retentionJob.update({
            where: { id: jobId },
            data: { ...data, combine, clauses: clauses as never },
          })
        : await prisma.retentionJob.create({
            data: { ...data, combine, clauses: clauses as never },
          });

      await audit(ctx.principal, ctx.ip, {
        action: jobId ? 'update' : 'create',
        cabinetId: input.cabinetId,
        detail: { what: 'retentionJob', name: job.name, action: job.expirationAction },
      });
      return job;
    }),

  delete: protectedProcedure
    .input(z.object({ jobId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const job = await prisma.retentionJob.findUnique({ where: { id: input.jobId } });
      if (!job) notFound('Retention job');
      if (!ctx.principal.isAdministrator) {
        const rights = ctx.principal.cabinetGrants.get(job.cabinetId);
        if (!rights?.has('File_Retention_Manage_Settings')) {
          badRequest('Missing right File_Retention_Manage_Settings.');
        }
      }
      await prisma.retentionJob.delete({ where: { id: input.jobId } });
      return { ok: true };
    }),

  /**
   * Dokmee: File_Retention_Expired_File_Queue — what *would* expire. A preview
   * rather than an action, because the configured action may be a permanent
   * delete.
   */
  expiredPreview: cabinetRight('File_Retention_Expired_File_Queue')
    .input(z.object({ cabinetId: z.string().uuid(), jobId: z.string().uuid() }))
    .query(async ({ input }) => {
      const job = await prisma.retentionJob.findUnique({ where: { id: input.jobId } });
      if (!job || job.cabinetId !== input.cabinetId) notFound('Retention job');

      const fields = await fieldsFor(input.cabinetId);
      const typeById = new Map<string, FieldType>(fields.map((f) => [f.id, f.type]));
      const compiled = compileClauses(
        job.clauses as unknown as RestrictionClause[],
        typeById,
        job.combine === 'or' ? 'or' : 'and',
      );

      const cutoff = new Date();
      cutoff.setFullYear(cutoff.getFullYear() - job.years);
      cutoff.setMonth(cutoff.getMonth() - job.months);
      cutoff.setDate(cutoff.getDate() - job.days);

      const dateCondition: Prisma.NodeWhereInput = job.retentionDateFieldId
        ? {
            indexValues: {
              some: { fieldId: job.retentionDateFieldId, dateValue: { lte: cutoff } },
            },
          }
        : { created: { lte: cutoff } };

      const where: Prisma.NodeWhereInput = {
        cabinetId: input.cabinetId,
        kind: 'document',
        inRecycleBin: false,
        AND: [dateCondition, ...(compiled ? [compiled] : [])],
      };

      const [count, sample] = await Promise.all([
        prisma.node.count({ where }),
        prisma.node.findMany({
          where,
          select: { id: true, name: true, created: true },
          orderBy: { created: 'asc' },
          take: 50,
        }),
      ]);

      return { cutoff, expirationAction: job.expirationAction, count, sample };
    }),

  /** Queues the job for the retention worker; it does not act inline. */
  runNow: systemRight('Run_Now_Scheduled_Jobs')
    .input(z.object({ jobId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const job = await prisma.retentionJob.findUnique({ where: { id: input.jobId } });
      if (!job) notFound('Retention job');

      const queued = await prisma.job.create({
        data: {
          kind: 'retention',
          cabinetId: job.cabinetId,
          payload: { retentionJobId: job.id },
          priority: 10,
        },
      });

      await audit(ctx.principal, ctx.ip, {
        action: 'update',
        cabinetId: job.cabinetId,
        detail: { what: 'retentionRunNow', name: job.name },
      });
      return { queuedJobId: queued.id };
    }),
});

export const notificationRouter = router({
  list: protectedProcedure.input(notificationQueryInput).query(async ({ ctx, input }) => {
    const where: Prisma.NotificationWhereInput = {
      userId: ctx.principal.userId,
      ...(input.unreadOnly ? { isViewed: false } : {}),
      ...(input.types?.length ? { type: { in: [...input.types] } } : {}),
      OR: [{ snoozeUntil: null }, { snoozeUntil: { lte: new Date() } }],
    };

    const [items, unread] = await Promise.all([
      prisma.notification.findMany({
        where,
        orderBy: { created: 'desc' },
        skip: input.skip,
        take: input.take,
      }),
      prisma.notification.count({
        where: { userId: ctx.principal.userId, isViewed: false },
      }),
    ]);
    return { items, unread };
  }),

  markViewed: protectedProcedure
    .input(z.object({ ids: z.array(z.string().uuid()).min(1).max(500) }))
    .mutation(async ({ ctx, input }) => {
      const result = await prisma.notification.updateMany({
        where: { id: { in: input.ids }, userId: ctx.principal.userId },
        data: { isViewed: true },
      });
      return { updated: result.count };
    }),

  markAllViewed: protectedProcedure.mutation(async ({ ctx }) => {
    const result = await prisma.notification.updateMany({
      where: { userId: ctx.principal.userId, isViewed: false },
      data: { isViewed: true },
    });
    return { updated: result.count };
  }),

  snooze: protectedProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        minutes: z.number().int().min(1).max(60 * 24 * 30),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await prisma.notification.updateMany({
        where: { id: input.id, userId: ctx.principal.userId },
        data: { snoozeUntil: new Date(Date.now() + input.minutes * 60_000) },
      });
      return { ok: true };
    }),
});

export const jobRouter = router({
  /** Queue depth per kind — what Dokmee's Services_Logs screen showed. */
  summary: systemRight('Services_Logs').query(async () => {
    const rows = await prisma.job.groupBy({
      by: ['kind', 'state'],
      _count: { _all: true },
    });
    return rows.map((r) => ({ kind: r.kind, state: r.state, count: r._count._all }));
  }),

  failed: systemRight('Services_Logs')
    .input(z.object({ take: z.number().int().min(1).max(200).default(50) }))
    .query(async ({ input }) =>
      prisma.job.findMany({
        where: { state: 'failed' },
        orderBy: { finishedAt: 'desc' },
        take: input.take,
      }),
    ),

  retry: systemRight('Run_Now_Scheduled_Jobs')
    .input(z.object({ ids: z.array(z.string().uuid()).min(1).max(500) }))
    .mutation(async ({ input }) => {
      const result = await prisma.job.updateMany({
        where: { id: { in: input.ids }, state: 'failed' },
        data: { state: 'queued', attempts: 0, lastError: null, runAfter: new Date() },
      });
      return { requeued: result.count };
    }),

  enqueue: adminProcedure.input(enqueueJobInput).mutation(async ({ input }) => {
    const job = await prisma.job.create({
      data: {
        kind: input.kind,
        cabinetId: input.cabinetId ?? null,
        nodeId: input.nodeId ?? null,
        payload: input.payload as never,
      },
    });
    return { jobId: job.id };
  }),
});
