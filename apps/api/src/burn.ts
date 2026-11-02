import {
  BlendMode,
  LineCapStyle,
  PDFDocument,
  StandardFonts,
  rgb,
  type PDFFont,
  type PDFPage,
  type RGB,
} from 'pdf-lib';
import type { Annotation } from '@ecm/domain';

/**
 * Burning: merging annotations into the page content of a produced PDF.
 *
 * Dokmee did this with Apryse (`BurnAnnotationsToFile`, `Flatten`,
 * `RefreshAnnotAppearances`); this draws the same marks into the content stream
 * with pdf-lib. Drawn into the content rather than added as PDF annotation
 * objects, because that is what burning means — the result reads the same in
 * every viewer, including ones that ignore `/Annots`, and cannot be switched
 * off by toggling comment visibility.
 *
 * Coordinates need no conversion: pdf-lib draws in PDF user space, which is
 * exactly how annotations are stored (points, origin bottom-left, y up).
 */

export interface BurnResult {
  bytes: Uint8Array;
  /** Annotations drawn, by name. */
  burned: string[];
  /**
   * Annotations that could not be drawn, with the reason. A burn that silently
   * dropped a markup would be worse than one that reports it: the row stays
   * unburned, so the next attempt can try again.
   */
  skipped: Array<{ name: string; reason: string }>;
}

function toRgb(hex: string): RGB {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim());
  if (!m) return rgb(1, 0.83, 0);
  return rgb(
    Number.parseInt(m[1]!, 16) / 255,
    Number.parseInt(m[2]!, 16) / 255,
    Number.parseInt(m[3]!, 16) / 255,
  );
}

/**
 * The standard fonts are WinAnsi-encoded, and `drawText` throws on a character
 * they cannot represent. A note written in Greek or Japanese must not take the
 * whole job down, so anything unencodable becomes a question mark — visible,
 * and honest about having lost something.
 */
function encodable(text: string, font: PDFFont): string {
  let out = '';
  for (const char of text) {
    try {
      font.encodeText(char);
      out += char;
    } catch {
      out += '?';
    }
  }
  return out;
}

function wrap(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split(/\r?\n/)) {
    let line = '';
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      const candidate = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
        line = candidate;
        continue;
      }
      if (line) lines.push(line);
      // A single word longer than the box is broken rather than overflowing.
      if (font.widthOfTextAtSize(word, size) > maxWidth) {
        let chunk = '';
        for (const char of word) {
          if (font.widthOfTextAtSize(chunk + char, size) > maxWidth) {
            lines.push(chunk);
            chunk = char;
          } else chunk += char;
        }
        line = chunk;
      } else line = word;
    }
    lines.push(line);
  }
  return lines;
}

/** Each group of eight quadpoints as a rectangle. */
function quads(coords: number[] | null | undefined): Array<{
  x: number;
  y: number;
  w: number;
  h: number;
}> {
  if (!coords?.length) return [];
  const out = [];
  for (let i = 0; i + 7 < coords.length; i += 8) {
    const xs = [coords[i]!, coords[i + 2]!, coords[i + 4]!, coords[i + 6]!];
    const ys = [coords[i + 1]!, coords[i + 3]!, coords[i + 5]!, coords[i + 7]!];
    const x = Math.min(...xs);
    const y = Math.min(...ys);
    out.push({ x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y });
  }
  return out;
}

function drawOne(
  page: PDFPage,
  a: Annotation,
  font: PDFFont,
): void {
  const color = toRgb(a.color);
  const opacity = a.opacity ?? 1;
  const thickness = a.width ?? 2;

  switch (a.kind) {
    case 'highlight':
      for (const q of quads(a.coords)) {
        page.drawRectangle({
          x: q.x,
          y: q.y,
          width: q.w,
          height: q.h,
          color,
          opacity,
          // Without multiply the fill paints over the glyphs and the
          // highlighted text is gone from the produced file for good.
          blendMode: BlendMode.Multiply,
        });
      }
      return;

    case 'underline':
      for (const q of quads(a.coords)) {
        page.drawLine({
          start: { x: q.x, y: q.y + 1 },
          end: { x: q.x + q.w, y: q.y + 1 },
          thickness: Math.max(0.75, thickness * 0.6),
          color,
          opacity,
        });
      }
      return;

    case 'strikeout':
      for (const q of quads(a.coords)) {
        page.drawLine({
          start: { x: q.x, y: q.y + q.h / 2 },
          end: { x: q.x + q.w, y: q.y + q.h / 2 },
          thickness: Math.max(0.75, thickness * 0.6),
          color,
          opacity,
        });
      }
      return;

    case 'squiggly':
      // No curve primitive, so the wave is short segments. At 3pt per half
      // period it reads as a squiggle at any sane zoom.
      for (const q of quads(a.coords)) {
        const baseline = q.y + 1;
        let up = true;
        for (let x = q.x; x < q.x + q.w; x += 3) {
          const next = Math.min(x + 3, q.x + q.w);
          page.drawLine({
            start: { x, y: up ? baseline : baseline + 2 },
            end: { x: next, y: up ? baseline + 2 : baseline },
            thickness: 0.75,
            color,
            opacity,
          });
          up = !up;
        }
      }
      return;

    case 'square':
      page.drawRectangle({
        x: a.rect.x1,
        y: a.rect.y1,
        width: a.rect.x2 - a.rect.x1,
        height: a.rect.y2 - a.rect.y1,
        borderColor: color,
        borderWidth: thickness,
        borderOpacity: opacity,
      });
      return;

    case 'circle':
      page.drawEllipse({
        x: (a.rect.x1 + a.rect.x2) / 2,
        y: (a.rect.y1 + a.rect.y2) / 2,
        xScale: (a.rect.x2 - a.rect.x1) / 2,
        yScale: (a.rect.y2 - a.rect.y1) / 2,
        borderColor: color,
        borderWidth: thickness,
        borderOpacity: opacity,
      });
      return;

    case 'line':
      page.drawLine({
        start: { x: a.rect.x1, y: a.rect.y1 },
        end: { x: a.rect.x2, y: a.rect.y2 },
        thickness,
        color,
        opacity,
        lineCap: LineCapStyle.Round,
      });
      return;

    case 'ink':
      for (const gesture of a.gestures ?? []) {
        for (let i = 0; i + 3 < gesture.length; i += 2) {
          page.drawLine({
            start: { x: gesture[i]!, y: gesture[i + 1]! },
            end: { x: gesture[i + 2]!, y: gesture[i + 3]! },
            thickness,
            color,
            opacity,
            // Round caps, or a freehand stroke shows a notch at every vertex.
            lineCap: LineCapStyle.Round,
          });
        }
      }
      return;

    case 'text':
    case 'freetext': {
      // A burned note whose text is lost is worth nothing, so the marker is
      // drawn with the comment beside it rather than on its own.
      const size = 8;
      const padding = 4;
      const maxWidth = 180;
      const body = encodable((a.contents ?? '').trim(), font);
      const marker = 14;

      page.drawRectangle({
        x: a.rect.x1,
        y: a.rect.y2 - marker,
        width: marker,
        height: marker,
        color,
        opacity,
        borderColor: rgb(0, 0, 0),
        borderWidth: 0.5,
        borderOpacity: 0.4,
      });

      if (!body) return;

      const lines = wrap(body, font, size, maxWidth - padding * 2);
      const boxWidth =
        Math.min(
          maxWidth,
          Math.max(...lines.map((l) => font.widthOfTextAtSize(l, size))) + padding * 2,
        );
      const boxHeight = lines.length * (size + 2) + padding * 2;
      const boxX = a.rect.x1 + marker + 4;
      const boxY = a.rect.y2 - boxHeight;

      page.drawRectangle({
        x: boxX,
        y: boxY,
        width: boxWidth,
        height: boxHeight,
        color: rgb(1, 1, 1),
        opacity: 0.88,
        borderColor: color,
        borderWidth: 0.75,
      });

      lines.forEach((line, i) => {
        page.drawText(line, {
          x: boxX + padding,
          y: boxY + boxHeight - padding - size - i * (size + 2),
          size,
          font,
          color: rgb(0.07, 0.09, 0.11),
        });
      });
      return;
    }

    default:
      // Unreachable for the declared kinds; a future kind is reported as
      // skipped by the caller rather than silently dropped.
      throw new Error(`no renderer for "${a.kind}"`);
  }
}

export async function burnAnnotations(
  source: Uint8Array,
  annotations: readonly Annotation[],
): Promise<BurnResult> {
  const pdf = await PDFDocument.load(source);
  const pages = pdf.getPages();
  const font = await pdf.embedFont(StandardFonts.Helvetica);

  const burned: string[] = [];
  const skipped: BurnResult['skipped'] = [];

  for (const a of annotations) {
    const page = pages[a.page];
    if (!page) {
      skipped.push({
        name: a.name,
        reason: `page ${a.page + 1} is beyond the document's ${pages.length}`,
      });
      continue;
    }
    try {
      drawOne(page, a, font);
      burned.push(a.name);
    } catch (error) {
      skipped.push({
        name: a.name,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { bytes: await pdf.save(), burned, skipped };
}
