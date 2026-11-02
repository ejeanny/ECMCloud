import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { prisma } from '@ecm/db';
import {
  canEnterCabinet,
  createCabinetInput,
  updateCabinetInput,
} from '@ecm/domain';
import { audit } from '../audit.js';
import { env } from '../env.js';
import {
  assertCanEnter,
  conflict,
  notFound,
  protectedProcedure,
  router,
  systemRight,
} from '../trpc.js';

/** Dokmee: FileCabinetController / RepoFileCabinetController. */
export const cabinetRouter = router({
  /** Cabinets this caller may enter, with their pinned state. */
  list: protectedProcedure.query(async ({ ctx }) => {
    const cabinets = await prisma.fileCabinet.findMany({
      orderBy: { name: 'asc' },
      include: {
        pinnedBy: { where: { userId: ctx.principal.userId } },
        _count: { select: { indexFields: true } },
      },
    });

    return cabinets
      .filter((c) => canEnterCabinet(ctx.principal, c.id))
      .map((c) => ({
        id: c.id,
        name: c.name,
        description: c.description,
        status: c.status,
        allowCustomFolder: c.allowCustomFolder,
        enableFullTextIndex: c.enableFullTextIndex,
        repoEncrypted: c.repoEncrypted,
        folderNameDisplayLimit: c.folderNameDisplayLimit,
        indexFieldCount: c._count.indexFields,
        isPinned: c.pinnedBy.length > 0,
        isDefault: c.pinnedBy[0]?.isDefault ?? false,
        isReadOnly: ctx.principal.readOnlyCabinets.has(c.id),
      }));
  }),

  byId: protectedProcedure
    .input(z.object({ cabinetId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      assertCanEnter(ctx.principal, input.cabinetId);
      const cabinet = await prisma.fileCabinet.findUnique({
        where: { id: input.cabinetId },
      });
      if (!cabinet) notFound('Cabinet');
      return cabinet;
    }),

  create: systemRight('Create_Database')
    .input(createCabinetInput)
    .mutation(async ({ ctx, input }) => {
      const existing = await prisma.fileCabinet.findUnique({
        where: { name: input.name },
      });
      if (existing) conflict(`A cabinet named "${input.name}" already exists.`);

      const cabinet = await prisma.fileCabinet.create({
        data: { ...input, primaryRepo: null },
      });

      // Dokmee created a database and a repository folder per cabinet; we
      // create only the folder (§6).
      const repo = path.join(env().REPOSITORY_ROOT, cabinet.id);
      await mkdir(repo, { recursive: true });
      await prisma.fileCabinet.update({
        where: { id: cabinet.id },
        data: { primaryRepo: repo },
      });

      // A new cabinet starts with the default title field, as Dokmee's
      // `Dms_DocumentTitleMapping` / IsDefault field does.
      await prisma.indexField.create({
        data: {
          cabinetId: cabinet.id,
          label: 'Document Title',
          type: 'text',
          isDefault: true,
          sort: 0,
        },
      });

      await audit(ctx.principal, ctx.ip, {
        action: 'create',
        cabinetId: cabinet.id,
        detail: { what: 'cabinet', name: cabinet.name },
      });

      return cabinet;
    }),

  update: systemRight('Database_Administration')
    .input(updateCabinetInput)
    .mutation(async ({ ctx, input }) => {
      const { cabinetId, ...data } = input;
      const cabinet = await prisma.fileCabinet.update({
        where: { id: cabinetId },
        data,
      });
      await audit(ctx.principal, ctx.ip, {
        action: 'update',
        cabinetId,
        detail: { what: 'cabinet' },
      });
      return cabinet;
    }),

  /**
   * Deleting a cabinet cascades to its nodes, fields, workflows and audit.
   * Blobs are left on disk and reclaimed by the `recycle` job, so a mistaken
   * delete is still recoverable from the repository.
   */
  delete: systemRight('Delete_Database')
    .input(z.object({ cabinetId: z.string().uuid(), confirmName: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const cabinet = await prisma.fileCabinet.findUnique({
        where: { id: input.cabinetId },
      });
      if (!cabinet) notFound('Cabinet');
      if (cabinet.name !== input.confirmName) {
        conflict('confirmName does not match the cabinet name.');
      }

      await prisma.fileCabinet.delete({ where: { id: cabinet.id } });
      await audit(ctx.principal, ctx.ip, {
        action: 'delete',
        detail: { what: 'cabinet', name: cabinet.name, id: cabinet.id },
      });
      return { ok: true };
    }),

  /** Dokmee: Dms_UsersPinnedCabinets. */
  setPinned: protectedProcedure
    .input(
      z.object({
        cabinetId: z.string().uuid(),
        pinned: z.boolean(),
        isDefault: z.boolean().default(false),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      assertCanEnter(ctx.principal, input.cabinetId);
      const key = { userId: ctx.principal.userId, cabinetId: input.cabinetId };

      if (!input.pinned) {
        await prisma.pinnedCabinet.deleteMany({ where: key });
        return { ok: true };
      }

      if (input.isDefault) {
        await prisma.pinnedCabinet.updateMany({
          where: { userId: ctx.principal.userId },
          data: { isDefault: false },
        });
      }
      await prisma.pinnedCabinet.upsert({
        where: { userId_cabinetId: key },
        update: { isDefault: input.isDefault },
        create: { ...key, isDefault: input.isDefault },
      });
      return { ok: true };
    }),

  /** Counts for the cabinet dashboard. */
  stats: protectedProcedure
    .input(z.object({ cabinetId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      assertCanEnter(ctx.principal, input.cabinetId);
      const [documents, folders, recycled, checkedOut, bytes] = await Promise.all([
        prisma.node.count({
          where: { cabinetId: input.cabinetId, kind: 'document', inRecycleBin: false },
        }),
        prisma.node.count({
          where: { cabinetId: input.cabinetId, kind: 'folder', inRecycleBin: false },
        }),
        prisma.node.count({ where: { cabinetId: input.cabinetId, inRecycleBin: true } }),
        prisma.node.count({
          where: { cabinetId: input.cabinetId, isCheckedOut: true, inRecycleBin: false },
        }),
        prisma.node.aggregate({
          where: { cabinetId: input.cabinetId, inRecycleBin: false },
          _sum: { byteLength: true },
        }),
      ]);

      return {
        documents,
        folders,
        recycled,
        checkedOut,
        totalBytes: Number(bytes._sum.byteLength ?? 0n),
      };
    }),
});
