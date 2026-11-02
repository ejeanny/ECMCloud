'use client';

import type { RenderedPage } from '@/lib/viewer/pdf';

export interface ViewerAnnotation {
  id?: string;
  name: string;
  kind: string;
  page: number;
  rect: { x1: number; y1: number; x2: number; y2: number };
  color: string;
  opacity: number;
  coords?: number[] | null;
  gestures?: number[][] | null;
  width?: number | null;
  contents?: string | null;
  author?: string | null;
  canEdit?: boolean;
  burnedAt?: Date | string | null;
}

interface Props {
  annotations: ViewerAnnotation[];
  page: RenderedPage;
  selected: string | null;
  onSelect: (name: string | null) => void;
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Draw the stored annotations for one page.
 *
 * Everything arrives in PDF user space and is converted here, which is why a
 * zoom or a rotation needs no stored value to change — the only thing that
 * moves is the page's transform.
 */
export function AnnotationShapes({ annotations, page, selected, onSelect }: Props) {
  /** A PDF-space rect as a viewport-space box. */
  function box(rect: ViewerAnnotation['rect']): Box {
    const [ax, ay] = page.toViewport(rect.x1, rect.y2);
    const [bx, by] = page.toViewport(rect.x2, rect.y1);
    return {
      x: Math.min(ax, bx),
      y: Math.min(ay, by),
      w: Math.abs(bx - ax),
      h: Math.abs(by - ay),
    };
  }

  /** XFDF quadpoints are eight numbers a quad: UL, UR, LL, LR. */
  function quads(coords: number[] | null | undefined): Box[] {
    if (!coords?.length) return [];
    const out: Box[] = [];
    for (let i = 0; i + 7 < coords.length; i += 8) {
      const xs = [coords[i]!, coords[i + 2]!, coords[i + 4]!, coords[i + 6]!];
      const ys = [coords[i + 1]!, coords[i + 3]!, coords[i + 5]!, coords[i + 7]!];
      out.push(
        box({
          x1: Math.min(...xs),
          y1: Math.min(...ys),
          x2: Math.max(...xs),
          y2: Math.max(...ys),
        }),
      );
    }
    return out;
  }

  return (
    <g>
      {annotations.map((a) => {
        const isSelected = a.name === selected;
        const stroke = a.width ?? 2;
        const common = {
          onClick: (event: React.MouseEvent) => {
            event.stopPropagation();
            onSelect(isSelected ? null : a.name);
          },
          style: { cursor: 'pointer' as const },
        };

        const shape = (() => {
          switch (a.kind) {
            case 'highlight':
              return quads(a.coords).map((q, i) => (
                <rect
                  key={i}
                  x={q.x}
                  y={q.y}
                  width={q.w}
                  height={q.h}
                  fill={a.color}
                  opacity={a.opacity}
                  // Without multiply the fill paints over the glyphs and the
                  // highlighted text becomes unreadable.
                  style={{ mixBlendMode: 'multiply' }}
                />
              ));

            case 'underline':
              return quads(a.coords).map((q, i) => (
                <line
                  key={i}
                  x1={q.x}
                  y1={q.y + q.h - 1}
                  x2={q.x + q.w}
                  y2={q.y + q.h - 1}
                  stroke={a.color}
                  strokeWidth={Math.max(1, stroke * 0.6)}
                  opacity={a.opacity}
                />
              ));

            case 'strikeout':
              return quads(a.coords).map((q, i) => (
                <line
                  key={i}
                  x1={q.x}
                  y1={q.y + q.h / 2}
                  x2={q.x + q.w}
                  y2={q.y + q.h / 2}
                  stroke={a.color}
                  strokeWidth={Math.max(1, stroke * 0.6)}
                  opacity={a.opacity}
                />
              ));

            case 'squiggly':
              return quads(a.coords).map((q, i) => {
                const baseline = q.y + q.h - 1;
                const step = 3;
                let d = `M ${q.x} ${baseline}`;
                for (let x = q.x; x < q.x + q.w; x += step * 2) {
                  d += ` q ${step} -${step} ${step * 2} 0`;
                }
                return (
                  <path
                    key={i}
                    d={d}
                    fill="none"
                    stroke={a.color}
                    strokeWidth={1}
                    opacity={a.opacity}
                  />
                );
              });

            case 'square': {
              const b = box(a.rect);
              return (
                <rect
                  x={b.x}
                  y={b.y}
                  width={b.w}
                  height={b.h}
                  fill="none"
                  stroke={a.color}
                  strokeWidth={stroke}
                  opacity={a.opacity}
                />
              );
            }

            case 'circle': {
              const b = box(a.rect);
              return (
                <ellipse
                  cx={b.x + b.w / 2}
                  cy={b.y + b.h / 2}
                  rx={b.w / 2}
                  ry={b.h / 2}
                  fill="none"
                  stroke={a.color}
                  strokeWidth={stroke}
                  opacity={a.opacity}
                />
              );
            }

            case 'line': {
              const [x1, y1] = page.toViewport(a.rect.x1, a.rect.y1);
              const [x2, y2] = page.toViewport(a.rect.x2, a.rect.y2);
              return (
                <line
                  x1={x1}
                  y1={y1}
                  x2={x2}
                  y2={y2}
                  stroke={a.color}
                  strokeWidth={stroke}
                  opacity={a.opacity}
                />
              );
            }

            case 'ink':
              return (a.gestures ?? []).map((gesture, i) => {
                const points: string[] = [];
                for (let p = 0; p + 1 < gesture.length; p += 2) {
                  const [x, y] = page.toViewport(gesture[p]!, gesture[p + 1]!);
                  points.push(`${x},${y}`);
                }
                return (
                  <polyline
                    key={i}
                    points={points.join(' ')}
                    fill="none"
                    stroke={a.color}
                    strokeWidth={stroke}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    opacity={a.opacity}
                  />
                );
              });

            case 'text': {
              // A sticky note is a marker, not a region: draw it at a constant
              // on-screen size so it stays clickable when zoomed out.
              const [x, y] = page.toViewport(a.rect.x1, a.rect.y2);
              return (
                <g transform={`translate(${x} ${y})`}>
                  <rect
                    width={18}
                    height={18}
                    rx={3}
                    fill={a.color}
                    stroke="rgba(0,0,0,.35)"
                  />
                  <path d="M4 6 h10 M4 9 h10 M4 12 h6" stroke="rgba(0,0,0,.55)" strokeWidth={1.2} />
                </g>
              );
            }

            case 'freetext': {
              const b = box(a.rect);
              return (
                <g>
                  <rect
                    x={b.x}
                    y={b.y}
                    width={b.w}
                    height={b.h}
                    fill="rgba(255,255,255,.85)"
                    stroke={a.color}
                    strokeWidth={1}
                  />
                  <text x={b.x + 4} y={b.y + 14} fontSize={12} fill="#111">
                    {a.contents ?? ''}
                  </text>
                </g>
              );
            }

            default:
              return null;
          }
        })();

        if (shape === null) return null;
        const b = box(a.rect);

        return (
          <g key={a.name} {...common} data-annotation={a.name}>
            {shape}
            {isSelected ? (
              <rect
                x={b.x - 3}
                y={b.y - 3}
                width={b.w + 6}
                height={b.h + 6}
                className="viewer-annotation-selected"
              />
            ) : null}
            {a.contents ? <title>{a.contents}</title> : null}
          </g>
        );
      })}
    </g>
  );
}
