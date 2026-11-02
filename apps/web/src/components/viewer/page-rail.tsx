'use client';

import { useEffect, useRef, useState } from 'react';

import {
  isRenderCancelled,
  type OpenDocument,
  type OutlineItem,
  type SearchHit,
} from '@/lib/viewer/pdf';
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
      } catch (cause) {
        // Superseded by a newer request for the same canvas: expected, and the
        // one that replaced it will draw.
        if (isRenderCancelled(cause)) return;
        // A page that will not draw small will report itself in the main view,
        // so the rail only leaves the slot blank — but it still says why, since
        // a silent catch here is what hid the render fault behind a thumbnail
        // that merely looked slow.
        console.error(`[rail] page ${index + 1} failed to draw`, cause);
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

/**
 * The search results, as a list you can read and click.
 *
 * Stepping with the arrows tells you nothing about what you are stepping
 * through. This gives every match its text and its page, marks the one you are
 * on, and goes to any of them — the other half of navigating a search, which a
 * next/previous pair alone cannot do. Apryse devotes a whole panel to it
 * (PDF-VIEWER.md §8.2).
 */
export function SearchRail({
  hits,
  active,
  searching,
  onGo,
}: {
  hits: SearchHit[];
  active: number;
  searching: boolean;
  onGo: (index: number) => void;
}) {
  return (
    <div className="h-full overflow-auto p-1.5 scrollbar-thin">
      <p className="text-muted-foreground px-1.5 pt-0.5 pb-1 text-[11px] font-semibold tracking-wider uppercase">
        {hits.length === 0 && !searching
          ? 'No matches'
          : `${hits.length} match${hits.length === 1 ? '' : 'es'}`}
        {searching ? ' so far…' : ''}
      </p>
      <ol className="m-0 list-none space-y-0.5 p-0">
        {hits.map((hit, index) => (
          <li key={`${hit.page}-${hit.start}`}>
            <button
              type="button"
              onClick={() => onGo(index)}
              aria-current={index === active}
              className={cn(
                'w-full cursor-pointer rounded-md px-2 py-1.5 text-left text-xs',
                index === active
                  ? 'bg-primary/10 text-foreground ring-primary/30 ring-1'
                  : 'hover:bg-muted text-muted-foreground',
              )}
            >
              <span className="text-muted-foreground mr-1.5 tabular-nums">p{hit.page + 1}</span>
              {hit.snippet}
            </button>
          </li>
        ))}
      </ol>
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
