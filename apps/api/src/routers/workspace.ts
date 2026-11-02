import { z } from 'zod';
import { prisma } from '@ecm/db';
import { addNoteInput, editNoteInput, nodeIdsInput, pageInput } from '@ecm/domain';
import { audit } from '../audit.js';
import { assertVisible } from '../visibility.js';
import {
  assertCabinetRight,
  conflict,
  notFound,
  protectedProcedure,
  router,
} from '../trpc.js';
import { nodeSelect, toDto } from './node.js';

/**
 * Per-user surface: notes, favourites and recents.
 *
 * Dokmee: FileNotesController (`Dms_FileNotes`), AddDocumentsToFavoritesAsync /
 * GetPagedUserFavoritesAsync (`User_Favorite_Files`) and `User_Recent_Files`.
 */
export const workspaceRouter = router({
  // --- notes ------------------------------------------------------------

  notes: protectedProcedure
    .input(z.object({ nodeId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const node = await prisma.node.findUnique({
        where: { id: input.nodeId },
        select: { id: true, cabinetId: true, kind: true },
      });
      if (!node) notFound('Document');
      assertCabinetRight(ctx.principal, node.cabinetId, 'View_FileNotes');
      await assertVisible(ctx.principal, node);

      const notes = await prisma.fileNote.findMany({
        where: { nodeId: input.nodeId },
        orderBy: { created: 'desc' },
        include: {
          user: { select: { userName: true, firstName: true, lastName: true } },
        },
      });
      return notes;
    }),

  addNote: protectedProcedure.input(addNoteInput).mutation(async ({ ctx, input }) => {
    const node = await prisma.node.findUnique({
      where: { id: input.nodeId },
      select: { id: true, cabinetId: true, kind: true, name: true },
    });
    if (!node) notFound('Document');
    assertCabinetRight(ctx.principal, node.cabinetId, 'Edit_FileNotes');
    await assertVisible(ctx.principal, node);

    const note = await prisma.fileNote.create({
      data: {
        nodeId: input.nodeId,
        userId: ctx.principal.userId,
        notes: input.notes,
      },
    });

    await audit(ctx.principal, ctx.ip, {
      action: 'create',
      cabinetId: node.cabinetId,
      nodeId: input.nodeId,
      nodeName: node.name,
      detail: { what: 'note' },
    });
    return note;
  }),

  editNote: protectedProcedure.input(editNoteInput).mutation(async ({ ctx, input }) => {
    const note = await prisma.fileNote.findUnique({
      where: { id: input.noteId },
      include: { node: { select: { cabinetId: true } } },
    });
    if (!note) notFound('Note');
    assertCabinetRight(ctx.principal, note.node.cabinetId, 'Edit_FileNotes');
    if (note.userId !== ctx.principal.userId && !ctx.principal.isAdministrator) {
      conflict('Only the author or an administrator can edit this note.');
    }

    return prisma.fileNote.update({
      where: { id: input.noteId },
      data: { notes: input.notes },
    });
  }),

  deleteNote: protectedProcedure
    .input(z.object({ noteId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const note = await prisma.fileNote.findUnique({
        where: { id: input.noteId },
        include: { node: { select: { cabinetId: true } } },
      });
      if (!note) notFound('Note');
      assertCabinetRight(ctx.principal, note.node.cabinetId, 'Edit_FileNotes');
      if (note.userId !== ctx.principal.userId && !ctx.principal.isAdministrator) {
        conflict('Only the author or an administrator can delete this note.');
      }
      await prisma.fileNote.delete({ where: { id: input.noteId } });
      return { ok: true };
    }),

  // --- favourites -------------------------------------------------------

  favorites: protectedProcedure.input(pageInput).query(async ({ ctx, input }) => {
    const where = { userId: ctx.principal.userId };
    const [rows, total] = await Promise.all([
      prisma.favorite.findMany({
        where,
        orderBy: { created: 'desc' },
        skip: input.skip,
        take: input.take,
        include: { node: { select: nodeSelect } },
      }),
      prisma.favorite.count({ where }),
    ]);

    return {
      items: rows
        .filter((r) => !ctx.principal.deniedCabinets.has(r.node.cabinetId))
        .map((r) => ({ addedAt: r.created, node: toDto(r.node) })),
      total,
    };
  }),

  addFavorites: protectedProcedure.input(nodeIdsInput).mutation(async ({ ctx, input }) => {
    const nodes = await prisma.node.findMany({
      where: { id: { in: input.nodeIds } },
      select: { id: true, cabinetId: true },
    });
    const allowed = nodes.filter(
      (n) => !ctx.principal.deniedCabinets.has(n.cabinetId),
    );

    await prisma.favorite.createMany({
      data: allowed.map((n) => ({ userId: ctx.principal.userId, nodeId: n.id })),
      skipDuplicates: true,
    });
    return { added: allowed.length };
  }),

  removeFavorites: protectedProcedure
    .input(nodeIdsInput)
    .mutation(async ({ ctx, input }) => {
      const result = await prisma.favorite.deleteMany({
        where: { userId: ctx.principal.userId, nodeId: { in: input.nodeIds } },
      });
      return { removed: result.count };
    }),

  // --- recents ----------------------------------------------------------

  recents: protectedProcedure.input(pageInput).query(async ({ ctx, input }) => {
    const rows = await prisma.recent.findMany({
      where: { userId: ctx.principal.userId },
      orderBy: { viewedAt: 'desc' },
      skip: input.skip,
      take: input.take,
      include: { node: { select: nodeSelect } },
    });
    return {
      items: rows
        .filter((r) => !ctx.principal.deniedCabinets.has(r.node.cabinetId))
        .map((r) => ({ viewedAt: r.viewedAt, node: toDto(r.node) })),
    };
  }),

  /** Called by the viewer when a document is opened. */
  touchRecent: protectedProcedure
    .input(z.object({ nodeId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      // Otherwise a hidden document could be written into the user's own
      // recents and then read back from there, around the restriction.
      const node = await prisma.node.findUnique({
        where: { id: input.nodeId },
        select: { id: true, cabinetId: true, kind: true },
      });
      if (!node) notFound('Document');
      assertCabinetRight(ctx.principal, node.cabinetId, 'View_Open');
      await assertVisible(ctx.principal, node);

      await prisma.recent.upsert({
        where: { userId_nodeId: { userId: ctx.principal.userId, nodeId: input.nodeId } },
        update: { viewedAt: new Date() },
        create: { userId: ctx.principal.userId, nodeId: input.nodeId },
      });

      // Keep the list bounded, as Dokmee's recent list is.
      const stale = await prisma.recent.findMany({
        where: { userId: ctx.principal.userId },
        orderBy: { viewedAt: 'desc' },
        skip: 100,
        select: { nodeId: true },
      });
      if (stale.length > 0) {
        await prisma.recent.deleteMany({
          where: {
            userId: ctx.principal.userId,
            nodeId: { in: stale.map((s) => s.nodeId) },
          },
        });
      }
      return { ok: true };
    }),

  // --- per-user settings ------------------------------------------------

  settings: protectedProcedure.query(async ({ ctx }) => {
    const row = await prisma.userSetting.findUnique({
      where: { userId: ctx.principal.userId },
    });
    return (row?.settings as Record<string, unknown>) ?? {};
  }),

  saveSettings: protectedProcedure
    .input(z.object({ settings: z.record(z.unknown()) }))
    .mutation(async ({ ctx, input }) => {
      await prisma.userSetting.upsert({
        where: { userId: ctx.principal.userId },
        update: { settings: input.settings as never },
        create: { userId: ctx.principal.userId, settings: input.settings as never },
      });
      return { ok: true };
    }),
});
