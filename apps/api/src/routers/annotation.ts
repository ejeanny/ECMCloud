import { z } from 'zod';
import { prisma } from '@ecm/db';
import {
  ANNOTATION_KINDS,
  TEXT_MARKUP_KINDS,
  fromXfdf,
  toXfdf,
  type Annotation as XfdfAnnotation,
  type AnnotationKind,
} from '@ecm/domain';
import { audit } from '../audit.js';
import {
  assertCabinetRight,
  badRequest,
  conflict,
  notFound,
  protectedProcedure,
  router,
} from '../trpc.js';

/**
 * Annotations.
 *
 * Dokmee stored one opaque XFDF blob per document (`AnnotationsData`) and
 * merged it into the file only on output; this keeps that separation — the
 * reason it matters is that the stored bytes are never rewritten by a markup,
 * so an annotation can be revoked and a document's hash stays meaningful —
 * but stores a row per annotation so authorship and dates are queryable.
 *
 * XFDF is the wire format in both directions (PDF-VIEWER.md §4), so what a user
 * draws here is readable by Acrobat and anything else that speaks PDF.
 */

const rectInput = z.object({
  x1: z.number().finite(),
  y1: z.number().finite(),
  x2: z.number().finite(),
  y2: z.number().finite(),
});

const annotationInput = z.object({
  name: z.string().min(1).max(120),
  kind: z.enum(ANNOTATION_KINDS as unknown as [AnnotationKind, ...AnnotationKind[]]),
  page: z.number().int().min(0).max(100_000),
  rect: rectInput,
  color: z.string().regex(/^#[0-9a-f]{6}$/i),
  opacity: z.number().min(0).max(1).default(1),
  // 8 numbers per marked line; a cap keeps one request from carrying a
  // pathological selection across a thousand pages.
  coords: z.array(z.number().finite()).max(8_000).optional(),
  gestures: z.array(z.array(z.number().finite()).max(20_000)).max(200).optional(),
  width: z.number().positive().max(200).optional(),
  contents: z.string().max(10_000).optional(),
});

type AnnotationInput = z.infer<typeof annotationInput>;

/** A stored row, as XFDF sees it. */
type Row = {
  name: string;
  kind: string;
  page: number;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  color: string;
  opacity: number;
  width: number | null;
  coords: unknown;
  gestures: unknown;
  contents: string | null;
  created: Date;
  modified: Date;
  author: { userName: string } | null;
};

function toXfdfAnnotation(row: Row): XfdfAnnotation {
  return {
    name: row.name,
    kind: row.kind as AnnotationKind,
    page: row.page,
    rect: { x1: row.x1, y1: row.y1, x2: row.x2, y2: row.y2 },
    color: row.color,
    opacity: row.opacity,
    coords: Array.isArray(row.coords) ? (row.coords as number[]) : undefined,
    gestures: Array.isArray(row.gestures) ? (row.gestures as number[][]) : undefined,
    width: row.width ?? undefined,
    contents: row.contents ?? undefined,
    author: row.author?.userName,
    created: row.created,
    modified: row.modified,
  };
}

const rowSelect = {
  id: true,
  name: true,
  kind: true,
  page: true,
  x1: true,
  y1: true,
  x2: true,
  y2: true,
  color: true,
  opacity: true,
  width: true,
  coords: true,
  gestures: true,
  contents: true,
  burnedAt: true,
  authorId: true,
  created: true,
  modified: true,
  author: { select: { userName: true } },
} as const;

/** Resolve the document and its cabinet, or fail the request. */
async function documentFor(nodeId: string) {
  const node = await prisma.node.findUnique({
    where: { id: nodeId },
    select: { id: true, cabinetId: true, name: true, kind: true },
  });
  if (!node || node.kind !== 'document') notFound('Document');
  return node;
}

/**
 * A text markup without quadpoints would render as a filled rectangle over
 * whatever happens to be under it, which is not what the user selected. Reject
 * it rather than draw something wrong.
 */
function validateGeometry(a: AnnotationInput): void {
  if (TEXT_MARKUP_KINDS.includes(a.kind)) {
    if (!a.coords || a.coords.length < 8 || a.coords.length % 8 !== 0) {
      badRequest(`A ${a.kind} needs quadpoints in multiples of eight.`);
    }
  }
  if (a.kind === 'ink' && !a.gestures?.length) {
    badRequest('An ink annotation needs at least one gesture.');
  }
}

function dataFor(a: AnnotationInput) {
  return {
    kind: a.kind,
    page: a.page,
    x1: Math.min(a.rect.x1, a.rect.x2),
    y1: Math.min(a.rect.y1, a.rect.y2),
    x2: Math.max(a.rect.x1, a.rect.x2),
    y2: Math.max(a.rect.y1, a.rect.y2),
    color: a.color.toLowerCase(),
    opacity: a.opacity,
    width: a.width ?? null,
    coords: (a.coords ?? null) as never,
    gestures: (a.gestures ?? null) as never,
    contents: a.contents ?? null,
  };
}

export const annotationRouter = router({
  /** Every annotation on a document, in page order. */
  list: protectedProcedure
    .input(z.object({ nodeId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const node = await documentFor(input.nodeId);
      assertCabinetRight(ctx.principal, node.cabinetId, 'View_Open');

      const rows = await prisma.annotation.findMany({
        where: { nodeId: node.id },
        orderBy: [{ page: 'asc' }, { created: 'asc' }],
        select: rowSelect,
      });

      return rows.map((row) => ({
        ...toXfdfAnnotation(row),
        id: row.id,
        burnedAt: row.burnedAt,
        /// Whether *this* user may change it, resolved here so the viewer does
        /// not have to re-derive the permission rules in the browser.
        canEdit:
          ctx.principal.isAdministrator ||
          row.authorId === ctx.principal.userId,
      }));
    }),

  /**
   * Create or update annotations by XFDF name. The viewer sends whole
   * annotations rather than patches, because a markup's geometry only makes
   * sense as a whole.
   */
  save: protectedProcedure
    .input(
      z.object({
        nodeId: z.string().uuid(),
        annotations: z.array(annotationInput).min(1).max(500),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const node = await documentFor(input.nodeId);
      for (const a of input.annotations) validateGeometry(a);

      const names = input.annotations.map((a) => a.name);
      if (new Set(names).size !== names.length) {
        badRequest('Two annotations in one request share a name.');
      }

      const existing = await prisma.annotation.findMany({
        where: { nodeId: node.id, name: { in: names } },
        select: { name: true, authorId: true, burnedAt: true },
      });
      const byName = new Map(existing.map((e) => [e.name, e]));

      // Adding and editing are separate privileges, so check whichever this
      // request actually needs — and only those.
      if (input.annotations.some((a) => !byName.has(a.name))) {
        assertCabinetRight(ctx.principal, node.cabinetId, 'Add_Annotation');
      }
      if (input.annotations.some((a) => byName.has(a.name))) {
        assertCabinetRight(ctx.principal, node.cabinetId, 'Edit_Annotation');
      }

      for (const a of input.annotations) {
        const prior = byName.get(a.name);
        if (!prior) continue;
        if (prior.burnedAt) {
          conflict(
            'This annotation has been burned into a produced file and can no longer be edited.',
          );
        }
        if (prior.authorId !== ctx.principal.userId && !ctx.principal.isAdministrator) {
          conflict('Only the author or an administrator can change this annotation.');
        }
      }

      const saved = await prisma.$transaction(
        input.annotations.map((a) =>
          prisma.annotation.upsert({
            where: { nodeId_name: { nodeId: node.id, name: a.name } },
            update: dataFor(a),
            create: {
              ...dataFor(a),
              nodeId: node.id,
              name: a.name,
              authorId: ctx.principal.userId,
            },
            select: rowSelect,
          }),
        ),
      );

      await audit(ctx.principal, ctx.ip, {
        action: 'update',
        cabinetId: node.cabinetId,
        nodeId: node.id,
        nodeName: node.name,
        detail: { what: 'annotations', count: saved.length },
      });

      return saved.map((row) => ({ ...toXfdfAnnotation(row), id: row.id }));
    }),

  remove: protectedProcedure
    .input(
      z.object({
        nodeId: z.string().uuid(),
        names: z.array(z.string().min(1).max(120)).min(1).max(500),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const node = await documentFor(input.nodeId);
      assertCabinetRight(ctx.principal, node.cabinetId, 'Delete_Annotation');

      const rows = await prisma.annotation.findMany({
        where: { nodeId: node.id, name: { in: input.names } },
        select: { id: true, authorId: true, burnedAt: true },
      });

      const removable = rows.filter((r) => {
        if (r.burnedAt) return false;
        return r.authorId === ctx.principal.userId || ctx.principal.isAdministrator;
      });

      if (removable.length > 0) {
        await prisma.annotation.deleteMany({
          where: { id: { in: removable.map((r) => r.id) } },
        });
        await audit(ctx.principal, ctx.ip, {
          action: 'delete',
          cabinetId: node.cabinetId,
          nodeId: node.id,
          nodeName: node.name,
          detail: { what: 'annotations', count: removable.length },
        });
      }

      return {
        removed: removable.length,
        // Says plainly what was left behind, rather than reporting a count the
        // caller cannot explain.
        kept: rows.length - removable.length,
      };
    }),

  /**
   * The whole markup as an XFDF document. This is the interop path: the result
   * imports into Acrobat, Apryse and anything else that reads XFDF.
   */
  exportXfdf: protectedProcedure
    .input(z.object({ nodeId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const node = await documentFor(input.nodeId);
      assertCabinetRight(ctx.principal, node.cabinetId, 'View_Open');

      const rows = await prisma.annotation.findMany({
        where: { nodeId: node.id },
        orderBy: [{ page: 'asc' }, { created: 'asc' }],
        select: rowSelect,
      });

      return {
        fileName: `${node.name}.xfdf`,
        xml: toXfdf(rows.map(toXfdfAnnotation), { href: node.name }),
      };
    }),

  /** Bring in a markup produced elsewhere. Existing names are updated. */
  importXfdf: protectedProcedure
    .input(
      z.object({
        nodeId: z.string().uuid(),
        xml: z.string().min(1).max(8 * 1024 * 1024),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const node = await documentFor(input.nodeId);
      assertCabinetRight(ctx.principal, node.cabinetId, 'Add_Annotation');

      let parsed: XfdfAnnotation[] = [];
      try {
        parsed = fromXfdf(input.xml);
      } catch {
        badRequest('That file is not readable as XFDF.');
      }
      if (parsed.length === 0) {
        badRequest('That XFDF contains no annotations this viewer can render.');
      }

      const rows = await prisma.$transaction(
        parsed.map((a) => {
          const data = dataFor({
            name: a.name,
            kind: a.kind,
            page: a.page,
            rect: a.rect,
            color: a.color,
            opacity: a.opacity,
            coords: a.coords,
            gestures: a.gestures,
            width: a.width,
            contents: a.contents,
          });
          return prisma.annotation.upsert({
            where: { nodeId_name: { nodeId: node.id, name: a.name } },
            update: data,
            create: {
              ...data,
              nodeId: node.id,
              name: a.name,
              authorId: ctx.principal.userId,
            },
            select: { id: true },
          });
        }),
      );

      await audit(ctx.principal, ctx.ip, {
        action: 'update',
        cabinetId: node.cabinetId,
        nodeId: node.id,
        nodeName: node.name,
        detail: { what: 'annotations', imported: rows.length },
      });

      return { imported: rows.length };
    }),

  /**
   * Queue a burn — merging the markup into a produced PDF.
   *
   * The handler is declared and fails with its reason, as the other engine-bound
   * kinds do: burning needs a PDF writer that can build appearance streams, and
   * shipping a version that drew approximate boxes would be worse than not
   * shipping one. PDF-VIEWER.md §7 sets out what it takes.
   */
  queueBurn: protectedProcedure
    .input(z.object({ nodeId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const node = await documentFor(input.nodeId);
      assertCabinetRight(ctx.principal, node.cabinetId, 'Burn_Annotation');

      const pending = await prisma.annotation.count({
        where: { nodeId: node.id, burnedAt: null },
      });
      if (pending === 0) conflict('This document has no unburned annotations.');

      const job = await prisma.job.create({
        data: {
          kind: 'burnAnnotations',
          cabinetId: node.cabinetId,
          nodeId: node.id,
          // Who asked travels with the job: the worker has no session, and a
          // burn is a permanent change that the audit trail has to attribute.
          payload: {
            nodeId: node.id,
            requestedBy: {
              userId: ctx.principal.userId,
              userName: ctx.principal.userName,
            },
          } as never,
        },
        select: { id: true },
      });
      return { jobId: job.id, annotations: pending };
    }),
});
