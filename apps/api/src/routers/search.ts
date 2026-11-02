import { z } from 'zod';
import { Prisma, prisma } from '@ecm/db';
import { searchInput, type FieldType, type RestrictionClause } from '@ecm/domain';
import { audit } from '../audit.js';
import { compileClauses, fieldsFor, viewRestrictionFor } from '../index-values.js';
import { roleIdsFor } from '../principal.js';
import { assertCanEnter, badRequest, router, protectedProcedure } from '../trpc.js';
import { nodeSelect, toDto } from './node.js';

/**
 * Dokmee: SearchDocumentsAsync and SearchMultipleCabinetsAsync (§3), plus
 * Export_Search_Results. Free text matches the name and the extracted
 * `FullText` Dokmee stored in-row; index-field criteria compile into the same
 * typed predicate the view restrictions use (index-values.ts).
 */
export const searchRouter = router({
  documents: protectedProcedure.input(searchInput).query(async ({ ctx, input }) => {
    const where = await buildWhere(ctx, input);
    const items = await prisma.node.findMany({
      where,
      select: nodeSelect,
      orderBy: [{ modified: input.sort?.dir ?? 'desc' }],
      skip: input.skip,
      take: input.take,
    });
    return { items: items.map(toDto) };
  }),

  /** Separate count, as Dokmee's GetPagedDocumentsCountAsync is. */
  count: protectedProcedure.input(searchInput).query(async ({ ctx, input }) => {
    const where = await buildWhere(ctx, input);
    return prisma.node.count({ where });
  }),

  /**
   * A text snippet around the first full-text hit, so a result row can show
   * why it matched without shipping whole documents to the browser.
   */
  snippets: protectedProcedure
    .input(
      z.object({
        nodeIds: z.array(z.string().uuid()).min(1).max(200),
        text: z.string().min(1).max(500),
        radius: z.number().int().min(20).max(500).default(120),
      }),
    )
    .query(async ({ ctx, input }) => {
      const nodes = await prisma.node.findMany({
        where: { id: { in: input.nodeIds } },
        select: { id: true, cabinetId: true, fullText: true },
      });

      const needle = input.text.toLowerCase();
      return nodes
        .filter((n) => assertReadable(ctx, n.cabinetId))
        .map((n) => {
          const hay = n.fullText ?? '';
          const at = hay.toLowerCase().indexOf(needle);
          if (at < 0) return { nodeId: n.id, snippet: null };
          const start = Math.max(0, at - input.radius);
          const end = Math.min(hay.length, at + needle.length + input.radius);
          return {
            nodeId: n.id,
            snippet: `${start > 0 ? '…' : ''}${hay.slice(start, end)}${end < hay.length ? '…' : ''}`,
            offset: at - start,
            length: needle.length,
          };
        });
    }),

  /** Dokmee: ExportSearchResultsCSVAsync — returns rows, the client writes the file. */
  exportRows: protectedProcedure.input(searchInput).query(async ({ ctx, input }) => {
    for (const cabinetId of input.cabinetIds) {
      if (!ctx.principal.isAdministrator) {
        const rights = ctx.principal.cabinetGrants.get(cabinetId);
        const allowed =
          rights?.has('Export_Search_Results') ||
          ctx.principal.systemGrants.has('Export_Search_Results');
        if (!allowed) badRequest('Missing right Export_Search_Results.');
      }
    }

    const where = await buildWhere(ctx, input);
    const [nodes, fieldSets] = await Promise.all([
      prisma.node.findMany({
        where,
        include: { indexValues: true },
        orderBy: { modified: 'desc' },
        take: 10_000,
      }),
      Promise.all(input.cabinetIds.map(async (id) => [id, await fieldsFor(id)] as const)),
    ]);

    const fieldsByCabinet = new Map(fieldSets);
    const rows = nodes.map((n) => {
      const fields = fieldsByCabinet.get(n.cabinetId) ?? [];
      const byField = new Map(n.indexValues.map((v) => [v.fieldId, v]));
      const record: Record<string, unknown> = {
        id: n.id,
        name: n.name,
        extension: n.ext,
        bytes: n.byteLength === null ? null : Number(n.byteLength),
        pages: n.pages,
        created: n.created,
        modified: n.modified,
      };
      for (const f of fields) {
        const v = byField.get(f.id);
        record[f.label] =
          v === undefined
            ? null
            : (v.textValue ??
              (v.numberValue === null ? null : Number(v.numberValue)) ??
              v.dateValue ??
              v.booleanValue ??
              null);
      }
      return record;
    });

    await audit(ctx.principal, ctx.ip, {
      action: 'export',
      detail: { what: 'searchResults', rows: rows.length, cabinets: input.cabinetIds },
    });

    return { rows, truncated: rows.length === 10_000 };
  }),
});

function assertReadable(
  ctx: { principal: { isAdministrator: boolean; deniedCabinets: ReadonlySet<string> } },
  cabinetId: string,
): boolean {
  return ctx.principal.isAdministrator || !ctx.principal.deniedCabinets.has(cabinetId);
}

async function buildWhere(
  ctx: { principal: Parameters<typeof assertCanEnter>[0] },
  input: z.infer<typeof searchInput>,
): Promise<Prisma.NodeWhereInput> {
  for (const cabinetId of input.cabinetIds) {
    assertCanEnter(ctx.principal, cabinetId);
  }

  const roleIds = await roleIdsFor(ctx.principal.userId);

  // Each cabinet carries its own field set and its own view restriction, so
  // a multi-cabinet search is an OR of per-cabinet predicates.
  const perCabinet = await Promise.all(
    input.cabinetIds.map(async (cabinetId): Promise<Prisma.NodeWhereInput> => {
      const [fields, restriction] = await Promise.all([
        fieldsFor(cabinetId),
        viewRestrictionFor(cabinetId, roleIds, ctx.principal.isAdministrator),
      ]);

      const typeById = new Map<string, FieldType>(fields.map((f) => [f.id, f.type]));
      const clauses: RestrictionClause[] = (input.fields ?? []).map((f) => ({
        fieldId: f.fieldId,
        operator: f.operator,
        value: f.value ?? null,
      }));

      const and: Prisma.NodeWhereInput[] = [{ cabinetId }];
      const compiled = compileClauses(clauses, typeById, 'and');
      if (compiled) and.push(compiled);
      if (restriction) and.push(restriction);

      return { AND: and };
    }),
  );

  const where: Prisma.NodeWhereInput = {
    kind: 'document',
    inRecycleBin: input.includeRecycleBin ? undefined : false,
    OR: perCabinet,
  };

  if (input.text) {
    const text = input.text;
    where.AND = [
      {
        OR: [
          { name: { contains: text, mode: 'insensitive' } },
          ...(input.fullText
            ? [{ fullText: { contains: text, mode: 'insensitive' as const } }]
            : []),
        ],
      },
    ];
  }

  if (input.createdFrom || input.createdTo) {
    where.created = {
      ...(input.createdFrom ? { gte: input.createdFrom } : {}),
      ...(input.createdTo ? { lte: input.createdTo } : {}),
    };
  }

  return where;
}
