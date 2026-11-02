import { z } from 'zod';
import { prisma } from '@ecm/db';
import {
  createIndexFieldInput,
  findReplaceIndexInput,
  updateIndexFieldInput,
} from '@ecm/domain';
import { audit } from '../audit.js';
import { fieldsFor } from '../index-values.js';
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

/**
 * Dokmee: IndexController / IndexingController / GlobalIndexController.
 *
 * Creating a field here inserts a row. In Dokmee it ran
 * `ALTER TABLE Dms_FsNodeIndex ADD [<label>]` (REVERSE-ENGINEERING.md §4),
 * which is why the label there doubled as a column name — and why we accept
 * labels that SQL would have rejected.
 */
export const indexFieldRouter = router({
  list: protectedProcedure
    .input(z.object({ cabinetId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      assertCanEnter(ctx.principal, input.cabinetId);
      const fields = await prisma.indexField.findMany({
        where: { cabinetId: input.cabinetId },
        orderBy: [{ sort: 'asc' }, { label: 'asc' }],
        include: { selectValues: { orderBy: { sort: 'asc' } } },
      });
      return fields;
    }),

  create: cabinetRight('Create_Index_Field')
    .input(createIndexFieldInput)
    .mutation(async ({ ctx, input }) => {
      const { selectValues, ...data } = input;
      const clash = await prisma.indexField.findUnique({
        where: { cabinetId_label: { cabinetId: input.cabinetId, label: input.label } },
      });
      if (clash) conflict(`A field labelled "${input.label}" already exists.`);

      if (
        (input.type === 'selectList' || input.type === 'multiSelect') &&
        (!selectValues || selectValues.length === 0)
      ) {
        badRequest('A select-list field needs at least one value.');
      }

      const field = await prisma.indexField.create({
        data: {
          ...data,
          selectValues: selectValues
            ? {
                create: selectValues.map((value, sort) => ({ value, sort })),
              }
            : undefined,
        },
        include: { selectValues: true },
      });

      await audit(ctx.principal, ctx.ip, {
        action: 'create',
        cabinetId: input.cabinetId,
        detail: { what: 'indexField', label: field.label, type: field.type },
      });
      return field;
    }),

  update: protectedProcedure
    .input(updateIndexFieldInput)
    .mutation(async ({ ctx, input }) => {
      const { fieldId, selectValues, ...data } = input;
      const existing = await prisma.indexField.findUnique({ where: { id: fieldId } });
      if (!existing) notFound('Index field');
      assertCabinetRight(ctx.principal, existing.cabinetId, 'Edit_Index_Field');

      const field = await prisma.$transaction(async (tx) => {
        if (selectValues) {
          await tx.selectListValue.deleteMany({ where: { fieldId } });
          await tx.selectListValue.createMany({
            data: selectValues.map((value, sort) => ({ fieldId, value, sort })),
          });
        }
        return tx.indexField.update({
          where: { id: fieldId },
          data,
          include: { selectValues: { orderBy: { sort: 'asc' } } },
        });
      });

      await audit(ctx.principal, ctx.ip, {
        action: 'update',
        cabinetId: existing.cabinetId,
        detail: { what: 'indexField', label: field.label },
      });
      return field;
    }),

  /** Deleting a field drops its values — the equivalent of DROP COLUMN. */
  delete: protectedProcedure
    .input(z.object({ fieldId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const field = await prisma.indexField.findUnique({ where: { id: input.fieldId } });
      if (!field) notFound('Index field');
      assertCabinetRight(ctx.principal, field.cabinetId, 'Delete_Index_Field');
      if (field.isDefault) badRequest('The default title field cannot be deleted.');
      if (field.isLocked) badRequest('A locked field cannot be deleted.');

      const used = await prisma.nodeIndexValue.count({ where: { fieldId: field.id } });
      await prisma.indexField.delete({ where: { id: field.id } });

      await audit(ctx.principal, ctx.ip, {
        action: 'delete',
        cabinetId: field.cabinetId,
        detail: { what: 'indexField', label: field.label, valuesDropped: used },
      });
      return { ok: true, valuesDropped: used };
    }),

  reorder: protectedProcedure
    .input(
      z.object({
        cabinetId: z.string().uuid(),
        order: z.array(z.string().uuid()).min(1).max(500),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      assertCabinetRight(ctx.principal, input.cabinetId, 'Index_Field_Management');
      await prisma.$transaction(
        input.order.map((fieldId, sort) =>
          prisma.indexField.update({ where: { id: fieldId }, data: { sort } }),
        ),
      );
      return { ok: true };
    }),

  /**
   * Dokmee: Find_Replace_IndexValue. Defaults to a dry run that reports the
   * match count, because this rewrites every matching document in one go.
   */
  findReplace: cabinetRight('Find_Replace_IndexValue')
    .input(findReplaceIndexInput)
    .mutation(async ({ ctx, input }) => {
      const field = await prisma.indexField.findUnique({ where: { id: input.fieldId } });
      if (!field || field.cabinetId !== input.cabinetId) notFound('Index field');

      const matches = await prisma.nodeIndexValue.findMany({
        where: {
          fieldId: input.fieldId,
          textValue: input.matchCase
            ? { contains: input.find }
            : { contains: input.find, mode: 'insensitive' },
          node: { cabinetId: input.cabinetId, inRecycleBin: false },
        },
        select: { nodeId: true, textValue: true },
      });

      if (input.dryRun) {
        return {
          dryRun: true as const,
          matched: matches.length,
          sample: matches.slice(0, 20).map((m) => ({
            nodeId: m.nodeId,
            before: m.textValue,
            after: replaceAll(m.textValue ?? '', input.find, input.replace, input.matchCase),
          })),
        };
      }

      await prisma.$transaction(
        matches.map((m) =>
          prisma.nodeIndexValue.update({
            where: { nodeId_fieldId: { nodeId: m.nodeId, fieldId: input.fieldId } },
            data: {
              textValue: replaceAll(
                m.textValue ?? '',
                input.find,
                input.replace,
                input.matchCase,
              ),
            },
          }),
        ),
      );

      await audit(ctx.principal, ctx.ip, {
        action: 'indexUpdate',
        cabinetId: input.cabinetId,
        detail: {
          what: 'findReplace',
          field: field.label,
          find: input.find,
          replace: input.replace,
          affected: matches.length,
        },
      });

      return { dryRun: false as const, matched: matches.length, sample: [] };
    }),

  /** Field metadata in the shape the document grid needs. */
  columns: protectedProcedure
    .input(z.object({ cabinetId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      assertCanEnter(ctx.principal, input.cabinetId);
      return fieldsFor(input.cabinetId);
    }),
});

function replaceAll(
  value: string,
  find: string,
  replace: string,
  matchCase: boolean,
): string {
  if (matchCase) return value.split(find).join(replace);
  const pattern = new RegExp(find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
  return value.replace(pattern, replace);
}
