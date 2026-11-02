'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { AnnotationKind } from '@ecm/domain';
import type { OpenDocument, RenderedPage } from '@/lib/viewer/pdf';
import { AnnotationShapes, type ViewerAnnotation } from './annotation-shapes';

export type Tool = 'select' | 'highlight' | 'underline' | 'strikeout' | 'ink' | 'note' | 'square';

/** What a completed gesture hands back, in PDF user space. */
export interface DraftAnnotation {
  kind: AnnotationKind;
  page: number;
  rect: { x1: number; y1: number; x2: number; y2: number };
  coords?: number[];
  gestures?: number[][];
  contents?: string;
}

interface Props {
  doc: OpenDocument;
  index: number;
  scale: number;
  rotation: number;
  tool: Tool;
  color: string;
  annotations: ViewerAnnotation[];
  /** PDF-space rects to flash as search hits. */
  highlights: Array<{ x1: number; y1: number; x2: number; y2: number }>;
  estimated: { width: number; height: number };
  onDraw: (draft: DraftAnnotation) => void;
  onSelectAnnotation: (name: string | null) => void;
  selected: string | null;
  /** Reported so the container can correct its layout estimate. */
  onMeasured: (index: number, size: { width: number; height: number }) => void;
  /** True while this page is inside the render window. */
  active: boolean;
}

/**
 * One page: a canvas, PDF.js's selectable text layer, and an SVG overlay for
 * annotations.
 *
 * The overlay is SVG rather than a second canvas so that an annotation is a DOM
 * node — it can be hit-tested, focused and styled, and a redraw costs nothing
 * on zoom because only the transform changes.
 */
export function ViewerPage({
  doc,
  index,
  scale,
  rotation,
  tool,
  color,
  annotations,
  highlights,
  estimated,
  onDraw,
  onSelectAnnotation,
  selected,
  onMeasured,
  active,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const textRef = useRef<HTMLDivElement | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [rendered, setRendered] = useState<RenderedPage | null>(null);
  const [size, setSize] = useState(estimated);
  const [drag, setDrag] = useState<{ from: [number, number]; to: [number, number] } | null>(null);
  const [stroke, setStroke] = useState<number[][]>([]);

  // Render, and re-render whenever the geometry changes. A render in flight is
  // abandoned by the generation check rather than cancelled, because PDF.js
  // resolves the old task anyway and the late result would overwrite the new one.
  const generation = useRef(0);
  useEffect(() => {
    if (!active) return;
    const canvas = canvasRef.current;
    if (!canvas) return;

    const mine = ++generation.current;
    let cancelled = false;

    (async () => {
      try {
        const page = await doc.render(index, canvas, { scale, rotation });
        if (cancelled || mine !== generation.current) return;
        setRendered(page);
        setSize({ width: page.width, height: page.height });
        onMeasured(index, { width: page.width, height: page.height });

        if (textRef.current) {
          await doc.renderText(index, textRef.current, { scale, rotation });
        }
      } catch {
        // A failed page should not take the document down; it stays blank at
        // the right size so the rest of the scroll position is undisturbed.
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [doc, index, scale, rotation, active, onMeasured]);

  useEffect(() => {
    if (active) return;
    // Leaving the window: drop the bitmap so a long document does not hold a
    // canvas per page, which is what actually exhausts memory.
    const canvas = canvasRef.current;
    if (canvas) {
      canvas.width = 0;
      canvas.height = 0;
    }
    textRef.current?.replaceChildren();
    setRendered(null);
  }, [active]);

  /** Pointer position in viewport pixels, relative to the page. */
  const pointAt = useCallback((event: React.PointerEvent): [number, number] => {
    const box = hostRef.current!.getBoundingClientRect();
    return [event.clientX - box.left, event.clientY - box.top];
  }, []);

  const drawing = tool === 'ink' || tool === 'square' || tool === 'note';

  function onPointerDown(event: React.PointerEvent) {
    if (!rendered || !drawing) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const at = pointAt(event);

    if (tool === 'note') {
      const [x, y] = rendered.toPdf(at[0], at[1]);
      // A sticky note has no dragged extent; give it a fixed 24pt square so it
      // is a sensible size in any other PDF reader too.
      onDraw({
        kind: 'text',
        page: index,
        rect: { x1: x, y1: y - 24, x2: x + 24, y2: y },
      });
      return;
    }
    if (tool === 'ink') setStroke([[...at]]);
    else setDrag({ from: at, to: at });
  }

  function onPointerMove(event: React.PointerEvent) {
    if (!rendered) return;
    const at = pointAt(event);
    if (tool === 'ink' && stroke.length > 0) setStroke((s) => [...s, [...at]]);
    else if (drag) setDrag({ from: drag.from, to: at });
  }

  function onPointerUp() {
    if (!rendered) return;

    if (tool === 'ink' && stroke.length > 1) {
      const gesture = stroke.flatMap(([x, y]) => rendered.toPdf(x!, y!));
      const xs = gesture.filter((_, i) => i % 2 === 0);
      const ys = gesture.filter((_, i) => i % 2 === 1);
      onDraw({
        kind: 'ink',
        page: index,
        rect: {
          x1: Math.min(...xs),
          y1: Math.min(...ys),
          x2: Math.max(...xs),
          y2: Math.max(...ys),
        },
        gestures: [gesture],
      });
    } else if (drag) {
      const a = rendered.toPdf(drag.from[0], drag.from[1]);
      const b = rendered.toPdf(drag.to[0], drag.to[1]);
      const rect = {
        x1: Math.min(a[0], b[0]),
        y1: Math.min(a[1], b[1]),
        x2: Math.max(a[0], b[0]),
        y2: Math.max(a[1], b[1]),
      };
      // A click that never moved is not a rectangle; ignore it rather than
      // storing a zero-area annotation nobody can see or select.
      if (rect.x2 - rect.x1 > 2 && rect.y2 - rect.y1 > 2) {
        onDraw({ kind: 'square', page: index, rect });
      }
    }

    setStroke([]);
    setDrag(null);
  }

  /** Turn the browser's text selection into XFDF quadpoints. */
  function markSelection(kind: Extract<AnnotationKind, 'highlight' | 'underline' | 'strikeout'>) {
    if (!rendered || !textRef.current) return;
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return;

    const range = selection.getRangeAt(0);
    if (!textRef.current.contains(range.commonAncestorContainer)) return;

    const host = hostRef.current!.getBoundingClientRect();
    const coords: number[] = [];
    const xs: number[] = [];
    const ys: number[] = [];

    for (const box of Array.from(range.getClientRects())) {
      if (box.width < 1 || box.height < 1) continue;
      const left = box.left - host.left;
      const top = box.top - host.top;
      const [x1, y1] = rendered.toPdf(left, top);
      const [x2, y2] = rendered.toPdf(left + box.width, top + box.height);
      // XFDF quadpoint order: upper-left, upper-right, lower-left, lower-right.
      const ux = Math.min(x1, x2);
      const vx = Math.max(x1, x2);
      const uy = Math.max(y1, y2);
      const vy = Math.min(y1, y2);
      coords.push(ux, uy, vx, uy, ux, vy, vx, vy);
      xs.push(ux, vx);
      ys.push(uy, vy);
    }

    if (coords.length === 0) return;
    onDraw({
      kind,
      page: index,
      rect: {
        x1: Math.min(...xs),
        y1: Math.min(...ys),
        x2: Math.max(...xs),
        y2: Math.max(...ys),
      },
      coords,
    });
    selection.removeAllRanges();
  }

  // The markup tools act on whatever is selected, so they fire on mouse-up in
  // the text layer rather than needing a separate confirm step.
  useEffect(() => {
    if (tool !== 'highlight' && tool !== 'underline' && tool !== 'strikeout') return;
    const host = hostRef.current;
    if (!host) return;
    const handler = () => markSelection(tool);
    host.addEventListener('mouseup', handler);
    return () => host.removeEventListener('mouseup', handler);
  });

  return (
    <div
      // A white sheet with a drop shadow, so a scanned page with white
      // margins still reads as paper against the grey behind it.
      className="relative flex-none bg-white shadow-[0_2px_10px_rgb(0_0_0/0.35)] [&>canvas]:block"
      data-page={index + 1}
      ref={hostRef}
      style={{ width: size.width, height: size.height }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    >
      <canvas ref={canvasRef} />
      <div
        className="viewer-text-layer"
        ref={textRef}
        // Text must not intercept the pointer while a shape tool is armed, or
        // the drag turns into a text selection instead of a rectangle.
        style={{ pointerEvents: drawing ? 'none' : 'auto' }}
      />

      {rendered ? (
        <svg
          className="absolute inset-0"
          width={size.width}
          height={size.height}
          style={{ pointerEvents: tool === 'select' ? 'auto' : 'none' }}
        >
          {highlights.map((rect, i) => {
            const [x1, y1] = rendered.toViewport(rect.x1, rect.y2);
            const [x2, y2] = rendered.toViewport(rect.x2, rect.y1);
            return (
              <rect
                key={`hit-${i}`}
                className="viewer-search-hit"
                x={Math.min(x1, x2)}
                y={Math.min(y1, y2)}
                width={Math.abs(x2 - x1)}
                height={Math.abs(y2 - y1)}
              />
            );
          })}

          <AnnotationShapes
            annotations={annotations}
            page={rendered}
            selected={selected}
            onSelect={onSelectAnnotation}
          />

          {/* The gesture in progress, drawn in viewport space since it has not
              been committed to PDF coordinates yet. */}
          {stroke.length > 1 ? (
            <polyline
              points={stroke.map(([x, y]) => `${x},${y}`).join(' ')}
              fill="none"
              stroke={color}
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          ) : null}
          {drag ? (
            <rect
              x={Math.min(drag.from[0], drag.to[0])}
              y={Math.min(drag.from[1], drag.to[1])}
              width={Math.abs(drag.to[0] - drag.from[0])}
              height={Math.abs(drag.to[1] - drag.from[1])}
              fill="none"
              stroke={color}
              strokeWidth={2}
              strokeDasharray="4 3"
            />
          ) : null}
        </svg>
      ) : null}

      {!rendered ? (
        <span className="absolute inset-0 grid place-items-center text-sm font-semibold text-neutral-400">
          {index + 1}
        </span>
      ) : null}
    </div>
  );
}
