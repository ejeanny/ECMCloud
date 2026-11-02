import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Prisma, prisma } from '@ecm/db';
import {
  copyNodesInput,
  createFolderInput,
  listNodesInput,
  moveNodesInput,
  nodeIdsInput,
  renameNodeInput,
  setIndexValuesInput,
  type FieldType,
} from '@ecm/domain';
import { audit, auditAsync } from '../audit.js';
import {
  fieldsFor,
  fromSlots,
  setIndexValues,
  viewRestrictionFor,
} from '../index-values.js';
import { roleIdsFor } from '../principal.js';
import {
  assertCabinetRight,
  assertCanEnter,
  badRequest,
  cabinetRight,
  conflict,
  notFound,
  protectedProcedure,
  router,
} from '../trpc.js';

/** Dokmee: FileSystemController — the 170-method core (§3). */

const nodeSelect = {
  id: true,
  cabinetId: true,
  parentId: true,
  kind: true,
  name: true,
  ext: true,
  path: true,
  byteLength: true,
  pages: true,
  sha256: true,
  isCheckedOut: true,
  checkedOutAt: true,
  inRecycleBin: true,
  deletedAt: true,
  hasDigitalSignature: true,
  isSigned: true,
  textExtractedAt: true,
  indexModified: true,
  created: true,
  modified: true,
} satisfies Prisma.NodeSelect;

export type NodeRow = Prisma.NodeGetPayload<{ select: typeof nodeSelect }>;

/** Serialises BigInt byteLength so the row survives JSON transport. */
function toDto(row: NodeRow) {
  return { ...row, byteLength: row.byteLength === null ? null : Number(row.byteLength) };
}

/** Resolves the node and asserts `right` in its cabinet. */
async function loadNode(
  principal: Parameters<typeof assertCabinetRight>[0],
  nodeId: string,
  right: Parameters<typeof assertCabinetRight>[2],
) {
  const node = await prisma.node.findUnique({ where: { id: nodeId } });
  if (!node) notFound('Document');
  assertCabinetRight(principal, node.cabinetId, right);
  return node;
}

/** Materialised path for a child of `parent`. */
function childPath(parent: { id: string; path: string } | null): string {
  return parent ? `${parent.path}${parent.id}/` : '/';
}

async function assertNameFree(
  cabinetId: string,
  parentId: string | null,
  name: string,
  exceptId?: string,
): Promise<void> {
  const cabinet = await prisma.fileCabinet.findUniqueOrThrow({
    where: { id: cabinetId },
    select: { allowDuplicateFileNames: true },
  });
  if (cabinet.allowDuplicateFileNames) return;

  const clash = await prisma.node.findFirst({
    where: {
      cabinetId,
      parentId,
      name,
      inRecycleBin: false,
      ...(exceptId ? { id: { not: exceptId } } : {}),
    },
    select: { id: true },
  });
  if (clash) conflict(`"${name}" already exists in this folder.`);
}

export const nodeRouter = router({
  /** Dokmee: GetPagedDocumentsAsync. */
  list: protectedProcedure.input(listNodesInput).query(async ({ ctx, input }) => {
    assertCanEnter(ctx.principal, input.cabinetId);

    const restriction = await viewRestrictionFor(
      input.cabinetId,
      await roleIdsFor(ctx.principal.userId),
      ctx.principal.isAdministrator,
    );

    const where: Prisma.NodeWhereInput = {
      cabinetId: input.cabinetId,
      parentId: input.parentId,
      inRecycleBin: input.inRecycleBin,
      ...(input.kind ? { kind: input.kind } : {}),
      // Folders are never hidden by a view restriction, or the tree breaks.
      ...(restriction ? { OR: [{ kind: 'folder' }, restriction] } : {}),
    };

    const items = await prisma.node.findMany({
      where,
      select: nodeSelect,
      orderBy: orderByFor(input.sort),
      skip: input.skip,
      take: input.take,
    });

    return { items: items.map(toDto) };
  }),

  /**
   * Dokmee: GetPagedDocumentsCountAsync — a separate call there, kept
   * separate here so a grid can page without recounting (§3).
   */
  count: protectedProcedure.input(listNodesInput).query(async ({ ctx, input }) => {
    assertCanEnter(ctx.principal, input.cabinetId);
    const restriction = await viewRestrictionFor(
      input.cabinetId,
      await roleIdsFor(ctx.principal.userId),
      ctx.principal.isAdministrator,
    );
    return prisma.node.count({
      where: {
        cabinetId: input.cabinetId,
        parentId: input.parentId,
        inRecycleBin: input.inRecycleBin,
        ...(input.kind ? { kind: input.kind } : {}),
        ...(restriction ? { OR: [{ kind: 'folder' }, restriction] } : {}),
      },
    });
  }),

  /** The folder tree for the explorer sidebar, one level at a time. */
  folders: protectedProcedure
    .input(
      z.object({
        cabinetId: z.string().uuid(),
        parentId: z.string().uuid().nullable().default(null),
      }),
    )
    .query(async ({ ctx, input }) => {
      assertCanEnter(ctx.principal, input.cabinetId);
      const folders = await prisma.node.findMany({
        where: {
          cabinetId: input.cabinetId,
          parentId: input.parentId,
          kind: 'folder',
          inRecycleBin: false,
        },
        select: { id: true, name: true, path: true, _count: { select: { children: true } } },
        orderBy: { name: 'asc' },
      });
      return folders.map((f) => ({
        id: f.id,
        name: f.name,
        path: f.path,
        hasChildren: f._count.children > 0,
      }));
    }),

  /** Dokmee: GetDocumentInfosAsync — full detail plus index values. */
  byId: protectedProcedure
    .input(z.object({ nodeId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const node = await prisma.node.findUnique({
        where: { id: input.nodeId },
        include: {
          indexValues: true,
          checkout: { include: { user: { select: { userName: true } } } },
          _count: { select: { versions: true, notes: true } },
        },
      });
      if (!node) notFound('Document');
      assertCabinetRight(ctx.principal, node.cabinetId, 'View_Open');

      const fields = await fieldsFor(node.cabinetId);
      const byField = new Map(node.indexValues.map((v) => [v.fieldId, v]));

      auditAsync(ctx.principal, ctx.ip, {
        action: 'view',
        cabinetId: node.cabinetId,
        nodeId: node.id,
        nodeName: node.name,
      });

      return {
        node: toDto(node),
        checkedOutBy: node.checkout?.user.userName ?? null,
        versionCount: node._count.versions,
        noteCount: node._count.notes,
        index: fields.map((f) => ({
          fieldId: f.id,
          label: f.label,
          type: f.type,
          isRequired: f.isRequired,
          isLocked: f.isLocked,
          value: fromSlots(f.type, byField.get(f.id) ?? {}),
        })),
      };
    }),

  /** Breadcrumb trail, resolved from the materialised path in one query. */
  breadcrumb: protectedProcedure
    .input(z.object({ nodeId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const node = await prisma.node.findUnique({
        where: { id: input.nodeId },
        select: { cabinetId: true, path: true, id: true, name: true, kind: true },
      });
      if (!node) notFound('Document');
      assertCanEnter(ctx.principal, node.cabinetId);

      const ids = node.path.split('/').filter(Boolean);
      if (ids.length === 0) return [{ id: node.id, name: node.name, kind: node.kind }];

      const ancestors = await prisma.node.findMany({
        where: { id: { in: ids } },
        select: { id: true, name: true, kind: true },
      });
      const byId = new Map(ancestors.map((a) => [a.id, a]));
      return [
        ...ids.flatMap((id) => {
          const a = byId.get(id);
          return a ? [a] : [];
        }),
        { id: node.id, name: node.name, kind: node.kind },
      ];
    }),

  createFolder: cabinetRight('Create_Folder')
    .input(createFolderInput)
    .mutation(async ({ ctx, input }) => {
      const parent = input.parentId
        ? await prisma.node.findUnique({
            where: { id: input.parentId },
            select: { id: true, path: true, cabinetId: true, kind: true },
          })
        : null;
      if (input.parentId && (!parent || parent.cabinetId !== input.cabinetId)) {
        notFound('Parent folder');
      }
      if (parent && parent.kind !== 'folder') badRequest('Parent must be a folder.');

      await assertNameFree(input.cabinetId, input.parentId, input.name);

      const folder = await prisma.node.create({
        data: {
          cabinetId: input.cabinetId,
          parentId: input.parentId,
          kind: 'folder',
          name: input.name,
          path: childPath(parent),
          createdById: ctx.principal.userId,
        },
        select: nodeSelect,
      });

      await audit(ctx.principal, ctx.ip, {
        action: 'create',
        cabinetId: input.cabinetId,
        nodeId: folder.id,
        nodeName: folder.name,
        detail: { what: 'folder' },
      });
      return toDto(folder);
    }),

  rename: protectedProcedure.input(renameNodeInput).mutation(async ({ ctx, input }) => {
    const node = await loadNode(ctx.principal, input.nodeId, 'Edit_Document');
    await assertNameFree(node.cabinetId, node.parentId, input.name, node.id);

    const updated = await prisma.node.update({
      where: { id: node.id },
      data: { name: input.name },
      select: nodeSelect,
    });

    await audit(ctx.principal, ctx.ip, {
      action: 'update',
      cabinetId: node.cabinetId,
      nodeId: node.id,
      nodeName: input.name,
      detail: { what: 'rename', from: node.name },
    });
    return toDto(updated);
  }),

  /**
   * Dokmee walked `TargetGuid` recursively; the materialised `path` lets a
   * whole subtree be repointed with one prefix update per moved root.
   */
  move: protectedProcedure.input(moveNodesInput).mutation(async ({ ctx, input }) => {
    const nodes = await prisma.node.findMany({ where: { id: { in: input.nodeIds } } });
    if (nodes.length !== input.nodeIds.length) notFound('Some documents');

    const cabinetIds = new Set(nodes.map((n) => n.cabinetId));
    if (cabinetIds.size > 1) badRequest('All documents must be in one cabinet.');
    const cabinetId = [...cabinetIds][0]!;
    assertCabinetRight(ctx.principal, cabinetId, 'Move_Document');

    const target = input.targetParentId
      ? await prisma.node.findUnique({
          where: { id: input.targetParentId },
          select: { id: true, path: true, cabinetId: true, kind: true },
        })
      : null;
    if (input.targetParentId && (!target || target.cabinetId !== cabinetId)) {
      notFound('Target folder');
    }
    if (target && target.kind !== 'folder') badRequest('Target must be a folder.');

    const newParentPath = childPath(target);

    for (const node of nodes) {
      // Moving a folder into its own subtree would detach the tree.
      if (target && (target.path + target.id + '/').startsWith(node.path + node.id + '/')) {
        badRequest(`Cannot move "${node.name}" into its own subtree.`);
      }
      await assertNameFree(cabinetId, input.targetParentId, node.name, node.id);
    }

    await prisma.$transaction(async (tx) => {
      for (const node of nodes) {
        const oldPrefix = `${node.path}${node.id}/`;
        const newPrefix = `${newParentPath}${node.id}/`;

        await tx.node.update({
          where: { id: node.id },
          data: { parentId: input.targetParentId, path: newParentPath },
        });

        if (node.kind === 'folder') {
          await tx.$executeRaw`
            UPDATE "node"
            SET "path" = ${newPrefix} || substring("path" from ${oldPrefix.length + 1})
            WHERE "cabinetId" = ${cabinetId}::uuid AND "path" LIKE ${`${oldPrefix}%`}
          `;
        }
      }
    });

    await audit(ctx.principal, ctx.ip, {
      action: 'move',
      cabinetId,
      detail: { count: nodes.length, targetParentId: input.targetParentId },
    });
    return { moved: nodes.length };
  }),

  /**
   * Copies metadata and index values; the blob is shared by reference (both
   * nodes point at the same `sha256`), so copying a 2 GB file is a row insert.
   */
  copy: protectedProcedure.input(copyNodesInput).mutation(async ({ ctx, input }) => {
    const nodes = await prisma.node.findMany({
      where: { id: { in: input.nodeIds } },
      include: { indexValues: true },
    });
    if (nodes.length === 0) notFound('Documents');

    const cabinetId = nodes[0]!.cabinetId;
    assertCabinetRight(ctx.principal, cabinetId, 'Copy_Document');
    if (nodes.some((n) => n.cabinetId !== cabinetId)) {
      badRequest('All documents must be in one cabinet.');
    }
    if (nodes.some((n) => n.kind === 'folder')) {
      badRequest('Folder copy is not supported; copy the documents instead.');
    }

    const target = input.targetParentId
      ? await prisma.node.findUnique({
          where: { id: input.targetParentId },
          select: { id: true, path: true, cabinetId: true },
        })
      : null;
    const newPath = childPath(target);

    const created = await prisma.$transaction(
      nodes.map((node) => {
        const id = randomUUID();
        return prisma.node.create({
          data: {
            id,
            cabinetId,
            parentId: input.targetParentId,
            kind: node.kind,
            name: node.name,
            ext: node.ext,
            path: newPath,
            byteLength: node.byteLength,
            pages: node.pages,
            sha256: node.sha256,
            // The copy shares the source's blob; the recycler deletes a blob
            // only when nothing references it any more.
            blobId: node.blobId,
            fullText: node.fullText,
            textExtractedAt: node.textExtractedAt,
            encryptedKey: node.encryptedKey,
            encryptionIv: node.encryptionIv,
            createdById: ctx.principal.userId,
            indexValues: {
              create: node.indexValues.map((v) => ({
                fieldId: v.fieldId,
                textValue: v.textValue,
                numberValue: v.numberValue,
                dateValue: v.dateValue,
                booleanValue: v.booleanValue,
              })),
            },
          },
          select: nodeSelect,
        });
      }),
    );

    await audit(ctx.principal, ctx.ip, {
      action: 'copy',
      cabinetId,
      detail: { count: created.length, targetParentId: input.targetParentId },
    });
    return created.map(toDto);
  }),

  /** Dokmee: Update_IndexValue / FileSystemIndexingController. */
  setIndexValues: protectedProcedure
    .input(setIndexValuesInput)
    .mutation(async ({ ctx, input }) => {
      const node = await loadNode(ctx.principal, input.nodeId, 'Update_IndexValue');
      if (node.isCheckedOut) {
        const checkout = await prisma.checkout.findUnique({ where: { nodeId: node.id } });
        if (checkout && checkout.userId !== ctx.principal.userId) {
          conflict('Document is checked out by another user.');
        }
      }

      await prisma.$transaction((tx) =>
        setIndexValues(tx, node.cabinetId, node.id, input.values),
      );

      await audit(ctx.principal, ctx.ip, {
        action: 'indexUpdate',
        cabinetId: node.cabinetId,
        nodeId: node.id,
        nodeName: node.name,
        detail: { fields: input.values.length },
      });
      return { ok: true };
    }),

  /** Dokmee: SendToRecycleBin — a soft delete, kept as `Bin` + `Deleted`. */
  sendToRecycleBin: protectedProcedure
    .input(nodeIdsInput)
    .mutation(async ({ ctx, input }) => {
      const nodes = await prisma.node.findMany({ where: { id: { in: input.nodeIds } } });
      if (nodes.length === 0) notFound('Documents');
      const cabinetId = nodes[0]!.cabinetId;
      assertCabinetRight(ctx.principal, cabinetId, 'Delete_Document');

      const subtreePaths = nodes
        .filter((n) => n.kind === 'folder')
        .map((n) => `${n.path}${n.id}/`);

      const affected = await prisma.node.updateMany({
        where: {
          cabinetId,
          OR: [
            { id: { in: nodes.map((n) => n.id) } },
            ...subtreePaths.map((p) => ({ path: { startsWith: p } })),
          ],
          inRecycleBin: false,
        },
        data: { inRecycleBin: true, deletedAt: new Date(), restoredAt: null },
      });

      await audit(ctx.principal, ctx.ip, {
        action: 'delete',
        cabinetId,
        detail: { what: 'recycle', count: affected.count },
      });
      return { recycled: affected.count };
    }),

  /** Dokmee: GetDocumentFullTextAsync. */
  fullText: protectedProcedure
    .input(z.object({ nodeId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const node = await loadNode(ctx.principal, input.nodeId, 'View_Open');
      return {
        fullText: node.fullText,
        extractedAt: node.textExtractedAt,
        pages: node.pages,
      };
    }),

  /** Dokmee: FileRelationships / FileRelationController. */
  relate: protectedProcedure
    .input(
      z.object({
        fromId: z.string().uuid(),
        toId: z.string().uuid(),
        kind: z.string().max(64).default('related'),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (input.fromId === input.toId) badRequest('A document cannot relate to itself.');
      const from = await loadNode(ctx.principal, input.fromId, 'Edit_Document');
      const to = await prisma.node.findUnique({ where: { id: input.toId } });
      if (!to) notFound('Related document');
      if (to.cabinetId !== from.cabinetId) {
        badRequest('Related documents must be in the same cabinet.');
      }

      await prisma.nodeRelation.upsert({
        where: {
          fromId_toId_kind: { fromId: input.fromId, toId: input.toId, kind: input.kind },
        },
        update: {},
        create: input,
      });
      return { ok: true };
    }),

  relations: protectedProcedure
    .input(z.object({ nodeId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const node = await loadNode(ctx.principal, input.nodeId, 'View_Open');
      const [out, incoming] = await Promise.all([
        prisma.nodeRelation.findMany({
          where: { fromId: node.id },
          include: { to: { select: { id: true, name: true, ext: true, kind: true } } },
        }),
        prisma.nodeRelation.findMany({
          where: { toId: node.id },
          include: { from: { select: { id: true, name: true, ext: true, kind: true } } },
        }),
      ]);
      return {
        outgoing: out.map((r) => ({ kind: r.kind, node: r.to })),
        incoming: incoming.map((r) => ({ kind: r.kind, node: r.from })),
      };
    }),
});

function orderByFor(
  sort: { by: string; dir: 'asc' | 'desc' } | undefined,
): Prisma.NodeOrderByWithRelationInput[] {
  const dir = sort?.dir ?? 'desc';
  switch (sort?.by) {
    case 'name':
      // Folders first, as every file explorer does.
      return [{ kind: 'asc' }, { name: dir }];
    case 'created':
      return [{ kind: 'asc' }, { created: dir }];
    case 'size':
      return [{ kind: 'asc' }, { byteLength: dir }];
    case 'ext':
      return [{ kind: 'asc' }, { ext: dir }, { name: 'asc' }];
    default:
      return [{ kind: 'asc' }, { modified: dir }];
  }
}

/** Exported for the search router, which shares the DTO shape. */
export { nodeSelect, toDto };
export type { FieldType };
