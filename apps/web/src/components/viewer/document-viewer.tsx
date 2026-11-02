'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { openPdf, type OpenDocument, type OutlineItem, type SearchHit } from '@/lib/viewer/pdf';
import { trpc } from '@/lib/trpc';
import { ViewerPage, type DraftAnnotation, type Tool } from './viewer-page';
import type { ViewerAnnotation } from './annotation-shapes';

interface Props {
  nodeId: string;
  name: string;
  onClose: () => void;
}

type Zoom = number | 'fit-width' | 'fit-page';

const COLORS = ['#ffd400', '#2bd48a', '#4aa3ff', '#ff6b6b', '#c084fc', '#111111'];

const TOOLS: Array<{ id: Tool; label: string; hint: string }> = [
  { id: 'select', label: 'Select', hint: 'Select text and annotations' },
  { id: 'highlight', label: 'Highlight', hint: 'Select text to highlight it' },
  { id: 'underline', label: 'Underline', hint: 'Select text to underline it' },
  { id: 'strikeout', label: 'Strike', hint: 'Select text to strike it out' },
  { id: 'ink', label: 'Draw', hint: 'Draw freehand' },
  { id: 'square', label: 'Box', hint: 'Drag a rectangle' },
  { id: 'note', label: 'Note', hint: 'Click to place a note' },
];

/**
 * The document viewer.
 *
 * Replaces Apryse WebViewer with PDF.js behind the seam in `lib/viewer/pdf.ts`.
 * The shape of the integration is deliberately the one recovered from Dokmee
 * (PDF-VIEWER.md): the viewer is handed a URL and a read-only flag, annotations
 * travel as XFDF and are stored beside the document, and nothing about the
 * viewer knows how permissions are decided.
 */
export function DocumentViewer({ nodeId, name, onClose }: Props) {
  const [doc, setDoc] = useState<OpenDocument | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);

  const [zoom, setZoom] = useState<Zoom>('fit-width');
  const [rotation, setRotation] = useState(0);
  const [basePage, setBasePage] = useState({ width: 612, height: 792 });
  const [sizes, setSizes] = useState<Array<{ width: number; height: number }>>([]);
  const [current, setCurrent] = useState(0);
  const [window_, setWindow] = useState<[number, number]>([0, 2]);

  const [tool, setTool] = useState<Tool>('select');
  const [color, setColor] = useState(COLORS[0]!);
  const [selected, setSelected] = useState<string | null>(null);

  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [outline, setOutline] = useState<OutlineItem[]>([]);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [viewportWidth, setViewportWidth] = useState(0);

  const utils = trpc.useUtils();
  const annotations = trpc.annotation.list.useQuery({ nodeId });
  const save = trpc.annotation.save.useMutation({
    onSuccess: () => utils.annotation.list.invalidate({ nodeId }),
  });
  const remove = trpc.annotation.remove.useMutation({
    onSuccess: () => {
      setSelected(null);
      void utils.annotation.list.invalidate({ nodeId });
    },
  });
  const importXfdf = trpc.annotation.importXfdf.useMutation({
    onSuccess: () => utils.annotation.list.invalidate({ nodeId }),
  });
  const burn = trpc.annotation.queueBurn.useMutation();

  // --- open -------------------------------------------------------------

  useEffect(() => {
    let disposed: OpenDocument | null = null;
    let cancelled = false;

    (async () => {
      try {
        const opened = await openPdf({
          url: `/file/${nodeId}`,
          onProgress: setProgress,
        });
        if (cancelled) {
          opened.destroy();
          return;
        }
        disposed = opened;
        setDoc(opened);
        const first = await opened.size(0, { scale: 1, rotation: 0 });
        setBasePage(first);
        setSizes(Array.from({ length: opened.pageCount }, () => first));
        void opened.outline().then((items) => !cancelled && setOutline(items));
      } catch (cause) {
        setError(
          cause instanceof Error
            ? `This document could not be opened: ${cause.message}`
            : 'This document could not be opened.',
        );
      }
    })();

    return () => {
      cancelled = true;
      disposed?.destroy();
    };
  }, [nodeId]);

  // Track the scroll container's width so the fit modes have something to
  // fit to; ResizeObserver rather than a resize listener, because the panel
  // can change width without the window doing so.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      setViewportWidth(entry!.contentRect.width);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [doc]);

  const scale = useMemo(() => {
    if (typeof zoom === 'number') return zoom;
    if (viewportWidth === 0) return 1;
    // The page is laid out at its rotated dimensions, so a quarter turn swaps
    // which side has to fit.
    const quarter = (rotation / 90) % 2 === 1;
    const pageW = quarter ? basePage.height : basePage.width;
    const pageH = quarter ? basePage.width : basePage.height;
    const fitWidth = (viewportWidth - 48) / pageW;
    if (zoom === 'fit-width') return Math.max(0.1, fitWidth);
    const el = scrollRef.current;
    const fitPage = el ? (el.clientHeight - 48) / pageH : fitWidth;
    return Math.max(0.1, Math.min(fitWidth, fitPage));
  }, [zoom, viewportWidth, basePage, rotation]);

  const onMeasured = useCallback(
    (index: number, size: { width: number; height: number }) => {
      setSizes((prev) => {
        const known = prev[index];
        if (
          known &&
          Math.abs(known.width - size.width) < 0.5 &&
          Math.abs(known.height - size.height) < 0.5
        ) {
          return prev;
        }
        const next = [...prev];
        next[index] = size;
        return next;
      });
    },
    [],
  );

  /**
   * Which pages to draw.
   *
   * A document-management viewer meets 400-page scans, and a canvas per page
   * exhausts memory long before the user reaches the end — so only a window
   * around the viewport is rendered, and the rest hold their measured height
   * so the scrollbar stays honest.
   */
  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el || sizes.length === 0) return;

    let offset = 0;
    let visible = 0;
    for (let i = 0; i < sizes.length; i++) {
      const height = (sizes[i]?.height ?? 0) + 16;
      if (offset + height > el.scrollTop + el.clientHeight * 0.3) {
        visible = i;
        break;
      }
      offset += height;
      visible = i;
    }
    setCurrent(visible);
    setWindow([Math.max(0, visible - 1), Math.min(sizes.length - 1, visible + 2)]);
  }, [sizes]);

  function goTo(page: number) {
    const el = scrollRef.current;
    if (!el) return;
    let offset = 0;
    for (let i = 0; i < page; i++) offset += (sizes[i]?.height ?? 0) + 16;
    el.scrollTo({ top: offset, behavior: 'smooth' });
  }

  // --- annotations ------------------------------------------------------

  function onDraw(draft: DraftAnnotation) {
    const contents =
      draft.kind === 'text'
        // A note with no text is just a marker nobody can read; ask for it at
        // the moment of placing, which is when the user knows what to write.
        ? (globalThis.prompt('Note') ?? '').trim()
        : undefined;
    if (draft.kind === 'text' && !contents) return;

    save.mutate({
      nodeId,
      annotations: [
        {
          name: crypto.randomUUID(),
          kind: draft.kind,
          page: draft.page,
          rect: draft.rect,
          color,
          opacity: draft.kind === 'highlight' ? 0.4 : 1,
          coords: draft.coords,
          gestures: draft.gestures,
          width: draft.kind === 'ink' || draft.kind === 'square' ? 2 : undefined,
          contents,
        },
      ],
    });
  }

  const byPage = useMemo(() => {
    const map = new Map<number, ViewerAnnotation[]>();
    for (const a of annotations.data ?? []) {
      const list = map.get(a.page) ?? [];
      list.push(a as ViewerAnnotation);
      map.set(a.page, list);
    }
    return map;
  }, [annotations.data]);

  const hitsByPage = useMemo(() => {
    const map = new Map<number, Array<{ x1: number; y1: number; x2: number; y2: number }>>();
    for (const hit of hits ?? []) {
      const list = map.get(hit.page) ?? [];
      list.push(...hit.rects);
      map.set(hit.page, list);
    }
    return map;
  }, [hits]);

  async function runSearch(event: React.FormEvent) {
    event.preventDefault();
    if (!doc || !query.trim()) {
      setHits(null);
      return;
    }
    setSearching(true);
    try {
      const found = await doc.search(query);
      setHits(found);
      if (found.length > 0) goTo(found[0]!.page);
    } finally {
      setSearching(false);
    }
  }

  async function downloadXfdf() {
    const result = await utils.annotation.exportXfdf.fetch({ nodeId });
    const blob = new Blob([result.xml], { type: 'application/vnd.adobe.xfdf' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = result.fileName;
    link.click();
    URL.revokeObjectURL(url);
  }

  async function uploadXfdf(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    importXfdf.mutate({ nodeId, xml: await file.text() });
  }

  const selectedAnnotation = (annotations.data ?? []).find((a) => a.name === selected);
  const total = annotations.data?.length ?? 0;

  if (error) {
    return (
      <div className="card error" role="alert">
        <p>{error}</p>
        <button onClick={onClose}>Close</button>
      </div>
    );
  }

  return (
    <div className="viewer">
      <div className="viewer-toolbar">
        <strong className="viewer-title" title={name}>
          {name}
        </strong>

        <span className="viewer-group">
          <button onClick={() => goTo(Math.max(0, current - 1))} title="Previous page">
            ‹
          </button>
          <span className="small mono">
            {doc ? `${current + 1} / ${doc.pageCount}` : '—'}
          </span>
          <button
            onClick={() => goTo(Math.min((doc?.pageCount ?? 1) - 1, current + 1))}
            title="Next page"
          >
            ›
          </button>
        </span>

        <span className="viewer-group">
          <button
            onClick={() => setZoom(Math.max(0.1, scale - 0.2))}
            title="Zoom out"
          >
            −
          </button>
          <span className="small mono">{Math.round(scale * 100)}%</span>
          <button onClick={() => setZoom(Math.min(8, scale + 0.2))} title="Zoom in">
            +
          </button>
          <button
            onClick={() => setZoom('fit-width')}
            style={zoom === 'fit-width' ? { borderColor: 'var(--accent)' } : undefined}
          >
            Fit width
          </button>
          <button
            onClick={() => setZoom('fit-page')}
            style={zoom === 'fit-page' ? { borderColor: 'var(--accent)' } : undefined}
          >
            Fit page
          </button>
          <button onClick={() => setRotation((r) => (r + 90) % 360)} title="Rotate">
            ⟳
          </button>
        </span>

        <span className="spacer" />

        <form onSubmit={runSearch} className="viewer-group">
          <input
            type="search"
            placeholder="Find in document"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            style={{ width: 170 }}
          />
          <button type="submit" disabled={searching}>
            {searching ? 'Searching…' : 'Find'}
          </button>
          {hits ? (
            <span className="small muted">
              {hits.length === 0 ? 'no matches' : `${hits.length} match${hits.length === 1 ? '' : 'es'}`}
            </span>
          ) : null}
        </form>

        <button onClick={onClose}>Close</button>
      </div>

      <div className="viewer-toolbar viewer-toolbar-second">
        <span className="viewer-group">
          {TOOLS.map((t) => (
            <button
              key={t.id}
              title={t.hint}
              onClick={() => setTool(t.id)}
              style={
                tool === t.id
                  ? { borderColor: 'var(--accent)', color: 'var(--accent)' }
                  : undefined
              }
            >
              {t.label}
            </button>
          ))}
        </span>

        <span className="viewer-group">
          {COLORS.map((c) => (
            <button
              key={c}
              aria-label={`Colour ${c}`}
              onClick={() => setColor(c)}
              className="viewer-swatch"
              style={{
                background: c,
                outline: color === c ? '2px solid var(--accent)' : 'none',
              }}
            />
          ))}
        </span>

        <span className="spacer" />

        <span className="small muted">
          {total} annotation{total === 1 ? '' : 's'}
        </span>
        <span className="viewer-group">
          <button onClick={downloadXfdf} disabled={total === 0} title="Export as XFDF">
            Export
          </button>
          <label className="pill" style={{ cursor: 'pointer' }}>
            Import
            <input
              type="file"
              accept=".xfdf,application/vnd.adobe.xfdf,text/xml"
              onChange={uploadXfdf}
              style={{ display: 'none' }}
            />
          </label>
          <button
            onClick={() => burn.mutate({ nodeId })}
            disabled={total === 0 || burn.isPending}
            title="Merge annotations into a produced PDF"
          >
            Burn
          </button>
        </span>
      </div>

      {save.error ? <p className="error small">{save.error.message}</p> : null}
      {remove.error ? <p className="error small">{remove.error.message}</p> : null}
      {importXfdf.error ? <p className="error small">{importXfdf.error.message}</p> : null}
      {burn.error ? <p className="error small">{burn.error.message}</p> : null}
      {burn.data ? (
        <p className="small muted">Burn queued as job {burn.data.jobId}.</p>
      ) : null}

      {selectedAnnotation ? (
        <div className="viewer-selection">
          <span className="small">
            <strong>{selectedAnnotation.kind}</strong>
            {selectedAnnotation.author ? ` by ${selectedAnnotation.author}` : ''}
            {selectedAnnotation.contents ? ` — ${selectedAnnotation.contents}` : ''}
          </span>
          <span className="spacer" />
          <button
            className="danger"
            disabled={!selectedAnnotation.canEdit || remove.isPending}
            onClick={() => remove.mutate({ nodeId, names: [selectedAnnotation.name] })}
          >
            Delete
          </button>
          <button onClick={() => setSelected(null)}>Deselect</button>
        </div>
      ) : null}

      <div className="viewer-body">
        {outline.length > 0 ? (
          <nav className="viewer-outline">
            <p className="small muted" style={{ margin: '0 0 6px' }}>
              Contents
            </p>
            <OutlineTree items={outline} onGo={goTo} />
          </nav>
        ) : null}

        <div className="viewer-scroll" ref={scrollRef} onScroll={onScroll}>
          {!doc ? (
            <p className="muted" style={{ padding: 24 }}>
              Loading{progress > 0 ? ` ${Math.round(progress * 100)}%` : ''}…
            </p>
          ) : (
            sizes.map((size, index) => (
              <ViewerPage
                key={index}
                doc={doc}
                index={index}
                scale={scale}
                rotation={rotation}
                tool={tool}
                color={color}
                annotations={byPage.get(index) ?? []}
                highlights={hitsByPage.get(index) ?? []}
                estimated={size}
                onDraw={onDraw}
                onSelectAnnotation={setSelected}
                selected={selected}
                onMeasured={onMeasured}
                active={index >= window_[0] && index <= window_[1]}
              />
            ))
          )}
        </div>
      </div>
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
    <ul style={{ listStyle: 'none', margin: 0, paddingLeft: 10 }}>
      {items.map((item, i) => (
        <li key={i}>
          <button
            className="viewer-outline-link small"
            disabled={item.page === null}
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
