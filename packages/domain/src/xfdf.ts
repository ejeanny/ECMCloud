import { XMLParser } from 'fast-xml-parser';

/**
 * XFDF — the annotation interchange format, kept deliberately (PDF-VIEWER.md §4).
 *
 * Annotations live beside the document and are merged into a PDF only when one
 * is produced, so a markup never rewrites the stored bytes and can be revoked.
 * Keeping the wire format XFDF rather than a private JSON means Acrobat and any
 * other PDF tool can still read what a user drew — Dokmee made the same choice,
 * and it is the one piece of its viewer contract worth copying exactly.
 *
 * Coordinates are PDF user space: points, origin at the bottom-left of the page,
 * y increasing upwards. The viewer converts to and from CSS pixels; nothing
 * stored here depends on a zoom level or a device.
 */

export const ANNOTATION_KINDS = [
  'highlight',
  'strikeout',
  'underline',
  'squiggly',
  'square',
  'circle',
  'ink',
  'text',
  'freetext',
  'line',
] as const;

export type AnnotationKind = (typeof ANNOTATION_KINDS)[number];

/** The kinds that mark up existing text and therefore carry `coords`. */
export const TEXT_MARKUP_KINDS: readonly AnnotationKind[] = [
  'highlight',
  'strikeout',
  'underline',
  'squiggly',
];

export interface Rect {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface Annotation {
  /** XFDF `name`: the stable id viewers use to correlate an edit with a row. */
  name: string;
  kind: AnnotationKind;
  /** 0-based, matching XFDF's own `page` attribute. */
  page: number;
  rect: Rect;
  /** `#rrggbb`. */
  color: string;
  /** 0..1. */
  opacity: number;
  /** Text markup: 8 numbers per marked line (the four corners of a quad). */
  coords?: number[];
  /** Ink: one flat `x,y,x,y…` list per gesture. */
  gestures?: number[][];
  /** Border width for ink, square, circle and line. */
  width?: number;
  contents?: string;
  /** XFDF `title`. */
  author?: string;
  created?: Date;
  modified?: Date;
}

const XFDF_NS = 'http://ns.adobe.com/xfdf/';

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** PDF date syntax, as XFDF's `date` and `creationdate` attributes use it. */
function toPdfDate(date: Date): string {
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return (
    `D:${date.getUTCFullYear()}${p(date.getUTCMonth() + 1)}${p(date.getUTCDate())}` +
    `${p(date.getUTCHours())}${p(date.getUTCMinutes())}${p(date.getUTCSeconds())}Z`
  );
}

function fromPdfDate(value: unknown): Date | undefined {
  if (typeof value !== 'string') return undefined;
  const m = /^D:(\d{4})(\d{2})(\d{2})(\d{2})?(\d{2})?(\d{2})?/.exec(value.trim());
  if (!m) {
    // Some producers write a plain ISO timestamp instead.
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? undefined : parsed;
  }
  // Groups 1–3 are not optional in the pattern, so a match has them.
  const [, y, mo, d, h, mi, s] = m;
  return new Date(
    Date.UTC(+y!, +mo! - 1, +d!, +(h ?? 0), +(mi ?? 0), +(s ?? 0)),
  );
}

function num(value: unknown): number | undefined {
  const n = typeof value === 'number' ? value : Number.parseFloat(String(value ?? ''));
  return Number.isFinite(n) ? n : undefined;
}

function numberList(value: unknown): number[] {
  if (value === null || value === undefined) return [];
  return String(value)
    .split(/[,\s]+/)
    .map((part) => Number.parseFloat(part))
    .filter((n) => Number.isFinite(n));
}

/** `#rrggbb`, lower-cased; anything unparseable becomes the fallback. */
function normaliseColor(value: unknown, fallback = '#ffd400'): string {
  const text = String(value ?? '').trim();
  const m = /^#?([0-9a-f]{6})$/i.exec(text);
  if (m) return `#${m[1]!.toLowerCase()}`;
  const short = /^#?([0-9a-f]{3})$/i.exec(text);
  if (short) {
    const [r, g, b] = short[1]!.toLowerCase();
    return `#${r}${r}${g}${g}${b}${b}`;
  }
  return fallback;
}

// --- serialise ------------------------------------------------------------

/**
 * Build an XFDF document. `href` records which file the markup belongs to, as
 * Acrobat expects in `<f href="…"/>`; it is advisory and safe to omit.
 */
export function toXfdf(
  annotations: readonly Annotation[],
  options?: { href?: string },
): string {
  const body = annotations.map(elementFor).join('\n');
  const f = options?.href ? `  <f href="${escapeXml(options.href)}"/>\n` : '';
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<xfdf xmlns="${XFDF_NS}" xml:space="preserve">\n` +
    f +
    `  <annots>\n${body}${body ? '\n' : ''}  </annots>\n` +
    `</xfdf>\n`
  );
}

function elementFor(a: Annotation): string {
  const attrs: string[] = [
    `page="${a.page}"`,
    `rect="${[a.rect.x1, a.rect.y1, a.rect.x2, a.rect.y2].map(round).join(',')}"`,
    `color="${a.color}"`,
    `opacity="${round(a.opacity)}"`,
    `name="${escapeXml(a.name)}"`,
  ];
  if (a.author) attrs.push(`title="${escapeXml(a.author)}"`);
  if (a.created) attrs.push(`creationdate="${toPdfDate(a.created)}"`);
  if (a.modified) attrs.push(`date="${toPdfDate(a.modified)}"`);
  if (a.width !== undefined) attrs.push(`width="${round(a.width)}"`);
  if (a.coords?.length) attrs.push(`coords="${a.coords.map(round).join(',')}"`);
  // A sticky note with no icon renders as a plain square in some viewers.
  if (a.kind === 'text') attrs.push('icon="Comment"');

  const children: string[] = [];
  if (a.contents) {
    children.push(`      <contents>${escapeXml(a.contents)}</contents>`);
  }
  if (a.kind === 'ink' && a.gestures?.length) {
    const gestures = a.gestures
      .map((g) => {
        const pairs: string[] = [];
        for (let i = 0; i + 1 < g.length; i += 2) {
          pairs.push(`${round(g[i]!)},${round(g[i + 1]!)}`);
        }
        return `        <gesture>${pairs.join(';')}</gesture>`;
      })
      .join('\n');
    children.push(`      <inklist>\n${gestures}\n      </inklist>`);
  }

  const open = `    <${a.kind} ${attrs.join(' ')}`;
  return children.length === 0
    ? `${open}/>`
    : `${open}>\n${children.join('\n')}\n    </${a.kind}>`;
}

function round(n: number): number {
  // Sub-thousandth-of-a-point precision is noise, and it bloats the document.
  return Math.round(n * 1000) / 1000;
}

// --- parse ----------------------------------------------------------------

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@',
  // XFDF elements are lower-case by spec, but producers disagree.
  transformTagName: (tag) => tag.toLowerCase().replace(/^.*:/, ''),
  transformAttributeName: (attr) => attr.toLowerCase().replace(/^.*:/, ''),
  parseAttributeValue: false,
  trimValues: false,
});

/**
 * Read an XFDF document produced by this viewer or by another PDF tool.
 *
 * Unknown annotation kinds are skipped rather than guessed at — a row that
 * cannot be rendered faithfully is worse than a visible gap, and the original
 * XFDF is what the importer still holds.
 */
export function fromXfdf(xml: string): Annotation[] {
  const doc = parser.parse(xml) as Record<string, unknown>;
  const xfdf = doc['xfdf'] as Record<string, unknown> | undefined;
  const annots = xfdf?.['annots'] as Record<string, unknown> | undefined;
  if (!annots) return [];

  const out: Annotation[] = [];
  for (const kind of ANNOTATION_KINDS) {
    const raw = annots[kind];
    if (!raw) continue;
    for (const node of Array.isArray(raw) ? raw : [raw]) {
      const parsed = annotationFrom(kind, node as Record<string, unknown>);
      if (parsed) out.push(parsed);
    }
  }
  // XFDF carries no document order, so give the caller a stable one.
  out.sort((a, b) => a.page - b.page || b.rect.y2 - a.rect.y2);
  return out;
}

function annotationFrom(
  kind: AnnotationKind,
  node: Record<string, unknown>,
): Annotation | null {
  const rectParts = numberList(node['@rect']);
  if (rectParts.length < 4) return null;

  const [x1, y1, x2, y2] = rectParts as [number, number, number, number];
  const page = num(node['@page']) ?? 0;
  const opacity = num(node['@opacity']);
  const width = num(node['@width']);

  const contents = textOf(node['contents']);
  const gestures = gesturesOf(node['inklist']);

  return {
    name: String(node['@name'] ?? crypto.randomUUID()),
    kind,
    page: Math.max(0, Math.trunc(page)),
    // Producers are not consistent about corner order; normalise so that
    // x1,y1 is the lower-left and the viewer never computes a negative size.
    rect: {
      x1: Math.min(x1, x2),
      y1: Math.min(y1, y2),
      x2: Math.max(x1, x2),
      y2: Math.max(y1, y2),
    },
    color: normaliseColor(node['@color']),
    opacity: opacity === undefined ? 1 : Math.min(1, Math.max(0, opacity)),
    coords: TEXT_MARKUP_KINDS.includes(kind) ? numberList(node['@coords']) : undefined,
    gestures: gestures.length ? gestures : undefined,
    width,
    contents: contents || undefined,
    author: node['@title'] === undefined ? undefined : String(node['@title']),
    created: fromPdfDate(node['@creationdate']),
    modified: fromPdfDate(node['@date']),
  };
}

function textOf(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') {
    const text = (value as Record<string, unknown>)['#text'];
    return text === undefined ? '' : String(text);
  }
  return String(value);
}

function gesturesOf(inklist: unknown): number[][] {
  if (!inklist || typeof inklist !== 'object') return [];
  const raw = (inklist as Record<string, unknown>)['gesture'];
  if (!raw) return [];
  const list = Array.isArray(raw) ? raw : [raw];
  return list
    .map((g) =>
      textOf(g)
        .split(';')
        .flatMap((pair) => numberList(pair))
        .filter((n) => Number.isFinite(n)),
    )
    .filter((g) => g.length >= 4);
}
