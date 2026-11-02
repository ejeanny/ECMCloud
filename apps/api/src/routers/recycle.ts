import { z } from 'zod';
import { prisma } from '@ecm/db';
import { nodeIdsInput, pageInput } from '@ecm/domain';
import { audit } from '../audit.js';
import { cabinetRight, conflict, notFound, router } from '../trpc.js';
import { nodeSelect, toDto } from './node.js';

/**
 * Dokmee: RecycleController / RecyclerController plus the `Dms_Recycle_Queue`
 * table its Recycler service drained (§2, §4). Purging only marks rows; the
 * `recycle` job removes the blobs, so a purge cannot block on disk I/O.
 */
export const recycleRouter = router({
  list: cabinetRight('Cut_Restore_Recycle_Bin')
    .input(pageInput.extend({ cabinetId: z.string().uuid() }))
    .query(async ({ input }) => {
      const where = { cabinetId: input.cabinetId, inRecycleBin: true };
      const [items, total] = await Promise.all([
        prisma.node.findMany({
          where,
          select: { ...nodeSelect, deletedAt: true },
          orderBy: { deletedAt: 'desc' },
          skip: input.skip,
          take: input.take,
        }),
        prisma.node.count({ where }),
      ]);
      return { items: items.map(toDto), total };
    }),

  /** Dokmee: RestoreFilesAsync. */
  restore: cabinetRight('Cut_Restore_Recycle_Bin')
    .input(nodeIdsInput.extend({ cabinetId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const nodes = await prisma.node.findMany({
        where: { id: { in: input.nodeIds }, cabinetId: input.cabinetId, inRecycleBin: true },
      });
      if (nodes.length === 0) notFound('Recycled documents');

      // Restoring into a folder that is itself recycled would hide the
      // document again, so the ancestors come back with it.
      const ancestorIds = new Set<string>();
      for (const node of nodes) {
        for (const id of node.path.split('/').filter(Boolean)) ancestorIds.add(id);
      }

      const subtreePaths = nodes
        .filter((n) => n.kind === 'folder')
        .map((n) => `${n.path}${n.id}/`);

      const restored = await prisma.node.updateMany({
        where: {
          cabinetId: input.cabinetId,
          inRecycleBin: true,
          OR: [
            { id: { in: [...nodes.map((n) => n.id), ...ancestorIds] } },
            ...subtreePaths.map((p) => ({ path: { startsWith: p } })),
          ],
        },
        data: { inRecycleBin: false, restoredAt: new Date(), deletedAt: null },
      });

      await audit(ctx.principal, ctx.ip, {
        action: 'restore',
        cabinetId: input.cabinetId,
        detail: { count: restored.count },
      });
      return { restored: restored.count };
    }),

  /** Dokmee: DeletePermanentlyAsync. */
  purge: cabinetRight('Empty_Recycle_Bin')
    .input(nodeIdsInput.extend({ cabinetId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const nodes = await prisma.node.findMany({
        where: { id: { in: input.nodeIds }, cabinetId: input.cabinetId, inRecycleBin: true },
        select: { id: true, name: true, kind: true, path: true, blobId: true },
      });
      if (nodes.length === 0) notFound('Recycled documents');

      const blobIds = await blobsOf(nodes.map((n) => n.id));

      const purged = await prisma.$transaction(async (tx) => {
        await tx.job.createMany({
          data: blobIds.map((blobId) => ({
            kind: 'recycle',
            cabinetId: input.cabinetId,
            payload: { blobId },
          })),
        });
        // Cascades remove versions, notes, index values and relations.
        const result = await tx.node.deleteMany({
          where: { id: { in: nodes.map((n) => n.id) } },
        });
        return result.count;
      });

      await audit(ctx.principal, ctx.ip, {
        action: 'purge',
        cabinetId: input.cabinetId,
        detail: { count: purged, names: nodes.slice(0, 20).map((n) => n.name) },
      });
      return { purged };
    }),

  /** Dokmee: Empty_Recycle_Bin. Requires the cabinet name, like cabinet.delete. */
  empty: cabinetRight('Empty_Recycle_Bin')
    .input(z.object({ cabinetId: z.string().uuid(), confirmName: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const cabinet = await prisma.fileCabinet.findUnique({
        where: { id: input.cabinetId },
        select: { name: true },
      });
      if (!cabinet) notFound('Cabinet');
      if (cabinet.name !== input.confirmName) {
        conflict('confirmName does not match the cabinet name.');
      }

      const doomed = await prisma.node.findMany({
        where: { cabinetId: input.cabinetId, inRecycleBin: true },
        select: { id: true },
      });
      if (doomed.length === 0) return { purged: 0 };

      const blobIds = await blobsOf(doomed.map((n) => n.id));

      const purged = await prisma.$transaction(async (tx) => {
        await tx.job.createMany({
          data: blobIds.map((blobId) => ({
            kind: 'recycle',
            cabinetId: input.cabinetId,
            payload: { blobId },
          })),
        });
        const result = await tx.node.deleteMany({
          where: { cabinetId: input.cabinetId, inRecycleBin: true },
        });
        return result.count;
      });

      await audit(ctx.principal, ctx.ip, {
        action: 'purge',
        cabinetId: input.cabinetId,
        detail: { what: 'emptyRecycleBin', count: purged },
      });
      return { purged };
    }),

  /** How much space the bin is holding, for the admin dashboard. */
  size: cabinetRight('Cut_Restore_Recycle_Bin')
    .input(z.object({ cabinetId: z.string().uuid() }))
    .query(async ({ input }) => {
      const agg = await prisma.node.aggregate({
        where: { cabinetId: input.cabinetId, inRecycleBin: true },
        _count: { _all: true },
        _sum: { byteLength: true },
      });
      return {
        count: agg._count._all,
        bytes: Number(agg._sum.byteLength ?? 0n),
      };
    }),
});

/**
 * Every blob these nodes reference, current and historical: the node's own
 * blob plus each of its versions'. Without the versions, purging a document
 * would leave its superseded content on disk for ever.
 */
async function blobsOf(nodeIds: readonly string[]): Promise<string[]> {
  const [nodes, versions] = await Promise.all([
    prisma.node.findMany({
      where: { id: { in: [...nodeIds] } },
      select: { blobId: true },
    }),
    prisma.nodeVersion.findMany({
      where: { nodeId: { in: [...nodeIds] } },
      select: { blobId: true },
    }),
  ]);

  const ids = new Set<string>();
  for (const row of [...nodes, ...versions]) {
    if (row.blobId) ids.add(row.blobId);
  }
  return [...ids];
}
