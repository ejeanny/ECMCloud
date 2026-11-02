'use client';

import { useEffect, useRef, useState } from 'react';

import type { OpenDocument, OutlineItem } from '@/lib/viewer/pdf';
import { cn } from '@/lib/utils';

const THUMB_WIDTH = 132;

/**
 * One page, drawn small.
 *
 * Thumbnails are rendered as they scroll into the rail rather than all at
 * once: a four-hundred-page scan would otherwise mean four hundred canvases
 * before the first one appears.
 */
function Thumb({
  doc,
  index,
  active,
  onGo,
}: {
  doc: OpenDocument;
  index: number;
  active: boolean;
  onGo: (page: number) => void;
}) {
  const hostRef = useRef<HTMLButtonElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [visible, setVisible] = useState(false);
  const [drawn, setDrawn] = useState(false);

  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      (entries) => entries.some((e) => e.isIntersecting) && setVisible(true),
      { root: el.closest('[data-rail]'), rootMargin: '200px' },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!visible || drawn) return;
    let cancelled = false;
    (async () => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      try {
        const full = await doc.size(index, { scale: 1, rotation: 0 });
        const scale = THUMB_WIDTH / full.width;
        await doc.render(index, canvas, { scale, rotation: 0 });
        if (!cancelled) setDrawn(true);
      } catch {
        // A page that will not draw small will report itself in the main
        // view; the rail just leaves the slot blank.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [visible, drawn, doc, index]);

  // Keep the current page in sight as the reader scrolls the document.
  useEffect(() => {
    if (active) hostRef.current?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  return (
    <button
      ref={hostRef}
      type="button"
      aria-label={`Go to page ${index + 1}`}
      aria-current={active ? 'true' : undefined}
      onClick={() => onGo(index)}
      className={cn(
        'group flex w-full cursor-pointer flex-col items-center gap-1 rounded-md p-1.5 transition-colors',
        active ? 'bg-primary/15' : 'hover:bg-muted',
      )}
    >
      <span
        className={cn(
          'relative block overflow-hidden rounded-sm border-2 bg-white',
          active ? 'border-primary' : 'border-transparent group-hover:border-border',
        )}
        style={{ width: THUMB_WIDTH, height: drawn ? undefined : THUMB_WIDTH * 1.29 }}
      >
        {/* An undrawn canvas is 300x150 by default, and letting that show
            through the frame looks like a broken thumbnail rather than one
            still being drawn. */}
        <canvas ref={canvasRef} className={cn('block', drawn ? '' : 'invisible absolute')} />
        {!drawn ? <span className="bg-muted block h-full w-full animate-pulse" /> : null}
      </span>
      <span
        className={cn(
          'text-xs tabular-nums',
          active ? 'text-primary font-semibold' : 'text-muted-foreground',
        )}
      >
        {index + 1}
      </span>
    </button>
  );
}

export function ThumbnailRail({
  doc,
  pageCount,
  current,
  onGo,
}: {
  doc: OpenDocument;
  pageCount: number;
  current: number;
  onGo: (page: number) => void;
}) {
  return (
    <div data-rail className="h-full overflow-auto p-1.5 scrollbar-thin">
      <div className="flex flex-col gap-1">
        {Array.from({ length: pageCount }).map((_, i) => (
          <Thumb key={i} doc={doc} index={i} active={i === current} onGo={onGo} />
        ))}
      </div>
    </div>
  );
}

export function OutlineRail({
  items,
  onGo,
}: {
  items: OutlineItem[];
  onGo: (page: number) => void;
}) {
  return (
    <div className="h-full overflow-auto p-3 scrollbar-thin">
      <OutlineTree items={items} onGo={onGo} />
    </div>
  );
}

function OutlineTree({
  items,
  onGo,
}: {
  items: OutlineItem[];
  onGo: (page: number) => void;
}) {
  return (
    <ul className="m-0 list-none pl-2.5">
      {items.map((item, i) => (
        <li key={i}>
          <button
            type="button"
            className="hover:text-primary w-full cursor-pointer truncate rounded-sm px-1 py-0.5 text-left text-xs disabled:cursor-default disabled:opacity-60"
            disabled={item.page === null}
            title={item.title || '(untitled)'}
            onClick={() => item.page !== null && onGo(item.page)}
          >
            {item.title || '(untitled)'}
          </button>
          {item.children.length > 0 ? (
            <OutlineTree items={item.children} onGo={onGo} />
          ) : null}
        </li>
      ))}
    </ul>
  );
}
