'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  Flame,
  Highlighter,
  Loader2,
  Maximize,
  MousePointer2,
  Pencil,
  RotateCw,
  Search,
  Square,
  Strikethrough,
  StickyNote,
  Trash2,
  Underline,
  Upload,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import { Textarea } from '@/components/ui/textarea';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { InlineError } from '@/components/states';
import { openPdf, type OpenDocument, type OutlineItem, type SearchHit } from '@/lib/viewer/pdf';
import { trpc } from '@/lib/trpc';
import { cn } from '@/lib/utils';
import { ViewerPage, type DraftAnnotation, type Tool } from './viewer-page';
import type { ViewerAnnotation } from './annotation-shapes';

interface Props {
  nodeId: string;
  name: string;
  onClose: () => void;
}

type Zoom = number | 'fit-width' | 'fit-page';

const COLORS = ['#ffd400', '#2bd48a', '#4aa3ff', '#ff6b6b', '#c084fc', '#111111'];

const TOOLS: Array<{
  id: Tool;
  label: string;
  hint: string;
  icon: typeof MousePointer2;
}> = [
  { id: 'select', label: 'Select', hint: 'Select text and annotations', icon: MousePointer2 },
  { id: 'highlight', label: 'Highlight', hint: 'Select text to highlight it', icon: Highlighter },
  { id: 'underline', label: 'Underline', hint: 'Select text to underline it', icon: Underline },
  { id: 'strikeout', label: 'Strike', hint: 'Select text to strike it out', icon: Strikethrough },
  { id: 'ink', label: 'Draw', hint: 'Draw freehand', icon: Pencil },
  { id: 'square', label: 'Box', hint: 'Drag a rectangle', icon: Square },
  { id: 'note', label: 'Note', hint: 'Click to place a note', icon: StickyNote },
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

  const [pendingNote, setPendingNote] = useState<DraftAnnotation | null>(null);
  const [noteText, setNoteText] = useState('');

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
  const burn = trpc.annotation.queueBurn.useMutation({
    onSuccess() {
      // The worker rewrites the file a moment later, so pick the result up
      // rather than leaving the toolbar claiming the marks are still pending.
      setTimeout(() => void utils.annotation.list.invalidate({ nodeId }), 3000);
    },
  });

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

  function commit(draft: DraftAnnotation, contents?: string) {
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

  function onDraw(draft: DraftAnnotation) {
    // A note with no text is just a marker nobody can read, so the text is
    // asked for at the moment of placing — which is when the user knows what
    // to write. A dialog rather than `window.prompt`: that one cannot be
    // styled, cannot be dismissed predictably, and blocks the page.
    if (draft.kind === 'text') {
      setPendingNote(draft);
      setNoteText('');
      return;
    }
    commit(draft);
  }

  const byPage = useMemo(() => {
    const map = new Map<number, ViewerAnnotation[]>();
    for (const a of annotations.data ?? []) {
      // A burned annotation is part of the page content now, so drawing it in
      // the overlay as well would double every mark — darker highlights, bolder
      // strokes — and make burning look like it had corrupted the file.
      if (a.burnedAt) continue;
      const list = map.get(a.page) ?? [];
      list.push(a as ViewerAnnotation);
      map.set(a.page, list);
    }
    return map;
  }, [annotations.data]);

  const burnedCount = (annotations.data ?? []).filter((a) => a.burnedAt).length;

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
      <Alert variant="destructive" className="max-w-xl">
        <CircleAlert />
        <AlertTitle>This document could not be opened</AlertTitle>
        <AlertDescription>
          <p>{error}</p>
          <Button variant="outline" size="sm" onClick={onClose}>
            Close
          </Button>
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      {/* Primary toolbar: where you are in the document, and how big it is. */}
      <div className="bg-card flex flex-wrap items-center gap-2 rounded-xl border p-2">
        <strong className="max-w-[22ch] truncate text-sm" title={name}>
          {name}
        </strong>

        <Separator orientation="vertical" className="h-5" />

        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Previous page"
            disabled={current === 0}
            onClick={() => goTo(Math.max(0, current - 1))}
          >
            <ChevronLeft />
          </Button>
          <span className="text-muted-foreground min-w-16 text-center font-mono text-xs tabular-nums">
            {doc ? `${current + 1} / ${doc.pageCount}` : '—'}
          </span>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Next page"
            disabled={!doc || current + 1 >= doc.pageCount}
            onClick={() => goTo(Math.min((doc?.pageCount ?? 1) - 1, current + 1))}
          >
            <ChevronRight />
          </Button>
        </div>

        <Separator orientation="vertical" className="h-5" />

        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Zoom out"
            onClick={() => setZoom(Math.max(0.1, scale - 0.2))}
          >
            <ZoomOut />
          </Button>
          <span className="text-muted-foreground min-w-12 text-center font-mono text-xs tabular-nums">
            {Math.round(scale * 100)}%
          </span>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Zoom in"
            onClick={() => setZoom(Math.min(8, scale + 0.2))}
          >
            <ZoomIn />
          </Button>
          <Button
            variant={zoom === 'fit-width' ? 'secondary' : 'ghost'}
            size="sm"
            onClick={() => setZoom('fit-width')}
          >
            Fit width
          </Button>
          <Button
            variant={zoom === 'fit-page' ? 'secondary' : 'ghost'}
            size="sm"
            onClick={() => setZoom('fit-page')}
          >
            <Maximize />
            Fit page
          </Button>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Rotate"
                onClick={() => setRotation((r) => (r + 90) % 360)}
              >
                <RotateCw />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Rotate a quarter turn</TooltipContent>
          </Tooltip>
        </div>

        <span className="flex-1" />

        <form onSubmit={runSearch} className="flex items-center gap-1.5">
          <div className="relative">
            <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2" />
            <Input
              type="search"
              className="h-8 w-44 pl-8"
              placeholder="Find in document"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <Button type="submit" size="sm" variant="outline" disabled={searching}>
            {searching ? <Loader2 className="animate-spin" /> : null}
            {searching ? 'Searching…' : 'Find'}
          </Button>
          {hits ? (
            <span className="text-muted-foreground text-xs whitespace-nowrap">
              {hits.length === 0
                ? 'no matches'
                : `${hits.length} match${hits.length === 1 ? '' : 'es'}`}
            </span>
          ) : null}
        </form>

        <Button variant="ghost" size="icon-sm" aria-label="Close viewer" onClick={onClose}>
          <X />
        </Button>
      </div>

      {/* Markup toolbar: what a drag or a click on the page will do. */}
      <div className="bg-muted/50 flex flex-wrap items-center gap-2 rounded-xl border p-2">
        <div className="flex items-center gap-1">
          {TOOLS.map((t) => {
            const Icon = t.icon;
            return (
              <Tooltip key={t.id}>
                <TooltipTrigger asChild>
                  <Button
                    variant={tool === t.id ? 'default' : 'ghost'}
                    size="icon-sm"
                    aria-label={t.label}
                    aria-pressed={tool === t.id}
                    onClick={() => setTool(t.id)}
                  >
                    <Icon />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{t.hint}</TooltipContent>
              </Tooltip>
            );
          })}
        </div>

        <Separator orientation="vertical" className="h-5" />

        <div className="flex items-center gap-1.5" role="group" aria-label="Annotation colour">
          {COLORS.map((c) => (
            <button
              key={c}
              type="button"
              aria-label={`Colour ${c}`}
              aria-pressed={color === c}
              onClick={() => setColor(c)}
              className={cn(
                'size-5 cursor-pointer rounded-full border transition-[box-shadow]',
                color === c
                  ? 'ring-ring ring-offset-background ring-2 ring-offset-2'
                  : 'border-border',
              )}
              style={{ background: c }}
            />
          ))}
        </div>

        <span className="flex-1" />

        <span className="text-muted-foreground text-xs">
          {total} annotation{total === 1 ? '' : 's'}
          {burnedCount > 0 ? `, ${burnedCount} burned in` : ''}
        </span>

        <div className="flex items-center gap-1.5">
          <Button
            variant="outline"
            size="sm"
            onClick={downloadXfdf}
            disabled={total === 0}
          >
            Export
          </Button>

          {/* A label wrapping a hidden input, so importing is one click and
              still uses the browser's own file picker. */}
          <Button variant="outline" size="sm" asChild>
            <label className="cursor-pointer">
              <Upload />
              Import
              <input
                type="file"
                accept=".xfdf,application/vnd.adobe.xfdf,text/xml"
                onChange={uploadXfdf}
                className="hidden"
              />
            </label>
          </Button>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                onClick={() => burn.mutate({ nodeId })}
                disabled={total === burnedCount || burn.isPending}
              >
                {burn.isPending ? <Loader2 className="animate-spin" /> : <Flame />}
                Burn
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              Merge the annotations into the page content, keeping the original as a
              version
            </TooltipContent>
          </Tooltip>
        </div>
      </div>

      {save.error ? <InlineError message={save.error.message} /> : null}
      {remove.error ? <InlineError message={remove.error.message} /> : null}
      {importXfdf.error ? <InlineError message={importXfdf.error.message} /> : null}
      {burn.error ? <InlineError message={burn.error.message} /> : null}

      {burn.data ? (
        <Alert variant="info">
          <Flame />
          <AlertDescription>
            Burning {burn.data.annotations} annotation
            {burn.data.annotations === 1 ? '' : 's'} into the page content (job{' '}
            <span className="font-mono">{burn.data.jobId.slice(0, 8)}</span>). The file
            before the burn is kept as a version — reload to see the result.
          </AlertDescription>
        </Alert>
      ) : null}

      {selectedAnnotation ? (
        <div className="bg-primary/10 border-primary/40 flex flex-wrap items-center gap-2 rounded-xl border p-2">
          <Badge variant="secondary">{selectedAnnotation.kind}</Badge>
          <span className="text-sm">
            {selectedAnnotation.author ? `by ${selectedAnnotation.author}` : ''}
            {selectedAnnotation.contents ? ` — ${selectedAnnotation.contents}` : ''}
          </span>
          <span className="flex-1" />
          <Button
            variant="ghost"
            size="sm"
            className="text-destructive hover:text-destructive"
            disabled={!selectedAnnotation.canEdit || remove.isPending}
            onClick={() => remove.mutate({ nodeId, names: [selectedAnnotation.name] })}
          >
            <Trash2 />
            Delete
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setSelected(null)}>
            Deselect
          </Button>
        </div>
      ) : null}

      <div className="flex min-h-0 flex-1 gap-2">
        {outline.length > 0 ? (
          <nav
            aria-label="Contents"
            className="bg-card hidden w-56 flex-none overflow-auto rounded-xl border p-3 scrollbar-thin lg:block"
          >
            <p className="text-muted-foreground mb-1.5 text-[11px] font-semibold tracking-wider uppercase">
              Contents
            </p>
            <OutlineTree items={outline} onGo={goTo} />
          </nav>
        ) : null}

        {/* A mid grey behind the page, so a white page reads as paper and the
            edge of a scanned page with a white margin is still visible. */}
        <div
          ref={scrollRef}
          onScroll={onScroll}
          className="flex min-w-0 flex-1 flex-col items-center gap-4 overflow-auto rounded-xl border bg-neutral-600 py-4 scrollbar-thin"
        >
          {!doc ? (
            <div className="text-muted-foreground flex items-center gap-2 p-8 text-sm text-neutral-200">
              <Loader2 className="size-4 animate-spin" />
              Loading{progress > 0 ? ` ${Math.round(progress * 100)}%` : ''}…
            </div>
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

      <Dialog
        open={pendingNote !== null}
        onOpenChange={(open) => !open && setPendingNote(null)}
      >
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Add a note</DialogTitle>
            <DialogDescription>
              Shown to anyone who can see this document&apos;s annotations.
            </DialogDescription>
          </DialogHeader>
          <form
            id="note-form"
            onSubmit={(event) => {
              event.preventDefault();
              const text = noteText.trim();
              if (!text || !pendingNote) return;
              commit(pendingNote, text);
              setPendingNote(null);
            }}
          >
            <Textarea
              autoFocus
              rows={3}
              value={noteText}
              placeholder="What should this note say?"
              onChange={(e) => setNoteText(e.target.value)}
            />
          </form>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPendingNote(null)}>
              Cancel
            </Button>
            <Button type="submit" form="note-form" disabled={!noteText.trim()}>
              Add note
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
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
