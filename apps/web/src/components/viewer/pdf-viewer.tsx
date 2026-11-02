'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  PanelLeftClose,
  PanelLeftOpen,
  Rows3,
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
import type { Rect } from '@ecm/domain';
import { openPdf, type OpenDocument, type OutlineItem, type SearchHit } from '@/lib/viewer/pdf';
import { OutlineRail, SearchRail, ThumbnailRail } from './page-rail';
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
export function PdfViewer({ nodeId, name, onClose }: Props) {
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

  const [rail, setRail] = useState<'thumbnails' | 'outline' | 'search' | null>('thumbnails');
  const [pageInput, setPageInput] = useState('1');

  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [searching, setSearching] = useState(false);
  /** Which hit the viewer is parked on; -1 before any has been chosen. */
  const [activeHit, setActiveHit] = useState(-1);
  const [annotationError, setAnnotationError] = useState<string | null>(null);
  const [outline, setOutline] = useState<OutlineItem[]>([]);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [viewportWidth, setViewportWidth] = useState(0);

  /** The query the current results belong to, so Enter can mean "next". */
  const lastQuery = useRef('');
  /** The walk in progress: a new query abandons it instead of racing it. */
  const search = useRef<AbortController | null>(null);
  /** A hit to scroll to once the results it belongs to are in state. */
  const queuedJump = useRef<number | null>(null);

  const utils = trpc.useUtils();
  const annotations = trpc.annotation.list.useQuery({ nodeId });
  /**
   * Draw first, then save.
   *
   * A mark used to appear only after the save had been round-tripped and the
   * whole list refetched — two requests between letting go of the mouse and
   * seeing anything, which reads as a viewer that is thinking about it. The
   * drawing is already known locally, so it goes into the cache immediately and
   * the server's answer only has to agree. A rejected save puts the list back
   * and says why, instead of leaving a mark that looks saved and is not.
   */
  const save = trpc.annotation.save.useMutation({
    onMutate: async (input) => {
      await utils.annotation.list.cancel({ nodeId });
      const previous = utils.annotation.list.getData({ nodeId });
      utils.annotation.list.setData({ nodeId }, (old) => [
        ...(old ?? []),
        ...(input.annotations as unknown as NonNullable<typeof old>),
      ]);
      return { previous };
    },
    onError: (cause, _input, context) => {
      utils.annotation.list.setData({ nodeId }, context?.previous);
      setAnnotationError(cause.message);
    },
    onSettled: () => utils.annotation.list.invalidate({ nodeId }),
  });
  const remove = trpc.annotation.remove.useMutation({
    onMutate: async (input) => {
      setSelected(null);
      await utils.annotation.list.cancel({ nodeId });
      const previous = utils.annotation.list.getData({ nodeId });
      const going = new Set(input.names);
      utils.annotation.list.setData({ nodeId }, (old) =>
        (old ?? []).filter((a) => !going.has(a.name)),
      );
      return { previous };
    },
    onError: (cause, _input, context) => {
      utils.annotation.list.setData({ nodeId }, context?.previous);
      setAnnotationError(cause.message);
    },
    onSettled: () => utils.annotation.list.invalidate({ nodeId }),
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

  /**
   * A page reports the size it actually rendered at, which is the size at the
   * current zoom. What is stored is the page's own size with that zoom divided
   * back out, so one array describes every page whatever the zoom is.
   */
  const onMeasured = useCallback(
    (index: number, size: { width: number; height: number }) => {
      const quarter = (rotation / 90) % 2 === 1;
      const base = quarter
        ? { width: size.height / scale, height: size.width / scale }
        : { width: size.width / scale, height: size.height / scale };

      setSizes((prev) => {
        const known = prev[index];
        if (
          known &&
          Math.abs(known.width - base.width) < 0.5 &&
          Math.abs(known.height - base.height) < 0.5
        ) {
          return prev;
        }
        const next = [...prev];
        next[index] = base;
        return next;
      });
    },
    [scale, rotation],
  );

  /**
   * Where each page sits once zoom and rotation are applied.
   *
   * This used to be `sizes` directly, which was filled in at zoom 1 and only
   * corrected for the handful of pages that had actually rendered — so at
   * fit-width every page that had not been drawn was understated by about
   * half, and jumping to page 9 landed on page 7. Deriving the laid-out height
   * from the page's own size means an undrawn page is placed as accurately as
   * a drawn one.
   */
  const layout = useMemo(() => {
    const quarter = (rotation / 90) % 2 === 1;
    return sizes.map((size) => ({
      width: (quarter ? size.height : size.width) * scale,
      height: (quarter ? size.width : size.height) * scale,
    }));
  }, [sizes, scale, rotation]);

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
    if (!el || layout.length === 0) return;

    let offset = 0;
    let visible = 0;
    for (let i = 0; i < layout.length; i++) {
      const height = (layout[i]?.height ?? 0) + 16;
      if (offset + height > el.scrollTop + el.clientHeight * 0.3) {
        visible = i;
        break;
      }
      offset += height;
      visible = i;
    }
    setCurrent(visible);
    setWindow([Math.max(0, visible - 1), Math.min(layout.length - 1, visible + 2)]);
  }, [layout]);

  useEffect(() => {
    setPageInput(String(current + 1));
  }, [current]);

  /**
   * Page keys, so a long document can be walked without the mouse. They are
   * deliberately not the arrow keys: those scroll, which is what a reader
   * expects them to do.
   */
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      if (target?.isContentEditable) return;
      if (!doc) return;

      const last = doc.pageCount - 1;
      switch (event.key) {
        case 'PageDown':
          event.preventDefault();
          goTo(Math.min(last, current + 1));
          break;
        case 'PageUp':
          event.preventDefault();
          goTo(Math.max(0, current - 1));
          break;
        case 'Home':
          event.preventDefault();
          goTo(0);
          break;
        case 'End':
          event.preventDefault();
          goTo(last);
          break;
        default:
          break;
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // `goTo` is stable enough for this: it only reads refs and `sizes`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, current, layout]);

  function goTo(page: number) {
    const el = scrollRef.current;
    if (!el) return;
    let offset = 0;
    for (let i = 0; i < page; i++) offset += (layout[i]?.height ?? 0) + 16;
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

  /**
   * Every hit on a page, with the active one marked.
   *
   * Apryse keeps the same two ideas apart (PDF-VIEWER.md §8): all results are
   * shown at once, and one of them is *active* — `displayAdditionalSearchResult`
   * against `setActiveSearchResult`. Without that distinction a search of a
   * long document is a page of identical yellow boxes with no way to tell which
   * one you were just taken to.
   */
  const hitsByPage = useMemo(() => {
    const map = new Map<number, Array<{ rect: Rect; active: boolean }>>();
    (hits ?? []).forEach((hit, index) => {
      const list = map.get(hit.page) ?? [];
      for (const rect of hit.rects) list.push({ rect, active: index === activeHit });
      map.set(hit.page, list);
    });
    return map;
  }, [hits, activeHit]);

  /** Put a hit on screen: its page, and the hit itself within that page. */
  const goToHit = useCallback(
    (index: number) => {
      const hit = hits?.[index];
      const el = scrollRef.current;
      if (!hit || !el) return;
      setActiveHit(index);

      // Draw the page now rather than when the scroll lands on it. A smooth
      // scroll across a long document takes long enough that the target would
      // otherwise arrive blank and fill in afterwards.
      setCurrent(hit.page);
      setWindow([Math.max(0, hit.page - 1), Math.min(layout.length - 1, hit.page + 2)]);

      let offset = 0;
      for (let i = 0; i < hit.page; i++) offset += (layout[i]?.height ?? 0) + 16;

      // Place the hit itself a third of the way down, rather than scrolling to
      // the top of its page and leaving the user to find it. The rect is in PDF
      // user space with y up, so what is above it is the rest of the page —
      // a fraction of this page's own height in points, against its height on
      // screen. Per page, because a document may mix page sizes.
      //
      // Turned a quarter, PDF y no longer runs down the screen at all and the
      // fraction would be nonsense: land on the page instead and let the
      // highlight be found.
      const onScreen = layout[hit.page];
      const points = sizes[hit.page];
      const top = hit.rects[0]?.y2;
      if (onScreen && points && top !== undefined && points.height > 0 && rotation % 180 === 0) {
        offset += Math.max(0, (1 - top / points.height) * onScreen.height - el.clientHeight / 3);
      }
      el.scrollTo({ top: offset, behavior: 'smooth' });
    },
    [hits, layout, sizes, rotation],
  );

  // The jump has to wait for the results to be in state, because that is what
  // decides which page is rendered and how tall the ones above it are.
  useEffect(() => {
    if (queuedJump.current === null || !hits || hits.length === 0) return;
    const index = queuedJump.current;
    queuedJump.current = null;
    goToHit(index);
  }, [hits, goToHit]);

  const step = useCallback(
    (by: 1 | -1) => {
      if (!hits || hits.length === 0) return;
      // Wrapping round is what every other find box does, and it saves the
      // user deciding whether they have reached the end.
      goToHit((activeHit + by + hits.length) % hits.length);
    },
    [hits, activeHit, goToHit],
  );

  async function runSearch(event: React.FormEvent) {
    event.preventDefault();
    // Submitting again with the same query means "next", the way a browser's
    // own find does, instead of searching the document a second time.
    if (hits && hits.length > 0 && query.trim() === lastQuery.current) {
      step(1);
      return;
    }
    if (!doc || !query.trim()) {
      setHits(null);
      setActiveHit(-1);
      return;
    }

    lastQuery.current = query.trim();
    // Show the results where they can be read, the way asking to search does
    // everywhere else; the rail is already open on the thumbnails.
    setRail('search');
    search.current?.abort();
    const abort = new AbortController();
    search.current = abort;

    setSearching(true);
    setHits([]);
    setActiveHit(-1);
    try {
      const collected: SearchHit[] = [];
      await doc.search(query, {
        signal: abort.signal,
        onPage: ({ hits: found }) => {
          if (found.length === 0 || abort.signal.aborted) return;
          collected.push(...found);
          // Show what has been found so far, and park on the first hit as soon
          // as there is one: the page it is on is then already rendering while
          // the rest of the document is still being read.
          setHits([...collected]);
          if (collected.length === found.length) {
            setActiveHit(0);
            queuedJump.current = 0;
          }
        },
      });
    } finally {
      if (!abort.signal.aborted) setSearching(false);
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

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant={rail ? 'secondary' : 'ghost'}
              size="icon-sm"
              aria-label={rail ? 'Hide the page rail' : 'Show the page rail'}
              aria-pressed={rail !== null}
              onClick={() => setRail((r) => (r === null ? 'thumbnails' : null))}
            >
              {rail ? <PanelLeftClose /> : <PanelLeftOpen />}
            </Button>
          </TooltipTrigger>
          <TooltipContent>Page thumbnails and contents</TooltipContent>
        </Tooltip>

        <Separator orientation="vertical" className="h-5" />

        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="First page"
            disabled={current === 0}
            onClick={() => goTo(0)}
          >
            <ChevronsLeft />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Previous page"
            disabled={current === 0}
            onClick={() => goTo(Math.max(0, current - 1))}
          >
            <ChevronLeft />
          </Button>

          {/* A box rather than a label: on a two-hundred-page scan, typing the
              page you want is the only quick way to reach it. */}
          <form
            className="flex items-center gap-1"
            onSubmit={(event) => {
              event.preventDefault();
              const wanted = Number.parseInt(pageInput, 10);
              if (Number.isFinite(wanted) && doc) {
                goTo(Math.min(doc.pageCount, Math.max(1, wanted)) - 1);
              } else {
                setPageInput(String(current + 1));
              }
            }}
          >
            <Input
              aria-label="Page number"
              inputMode="numeric"
              className="h-7 w-12 px-1 text-center font-mono text-xs tabular-nums"
              value={pageInput}
              onChange={(e) => setPageInput(e.target.value)}
              onBlur={() => setPageInput(String(current + 1))}
            />
            <span className="text-muted-foreground font-mono text-xs tabular-nums">
              / {doc?.pageCount ?? '—'}
            </span>
          </form>

          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Next page"
            disabled={!doc || current + 1 >= doc.pageCount}
            onClick={() => goTo(Math.min((doc?.pageCount ?? 1) - 1, current + 1))}
          >
            <ChevronRight />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Last page"
            disabled={!doc || current + 1 >= doc.pageCount}
            onClick={() => goTo((doc?.pageCount ?? 1) - 1)}
          >
            <ChevronsRight />
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
              // Shift+Enter walks backwards, as in a browser's own find bar.
              // Enter alone is handled by the form, where repeating the same
              // query steps to the next match instead of searching again.
              onKeyDown={(e) => {
                if (e.key === 'Enter' && e.shiftKey) {
                  e.preventDefault();
                  step(-1);
                }
              }}
            />
          </div>
          <Button type="submit" size="sm" variant="outline" disabled={searching}>
            {searching ? <Loader2 className="animate-spin" /> : null}
            {searching ? 'Searching…' : 'Find'}
          </Button>

          {hits && hits.length > 0 ? (
            <>
              {/* Which match of how many. Without it, stepping through a long
                  document tells you nothing about where you are in it. */}
              <span className="text-muted-foreground text-xs whitespace-nowrap tabular-nums">
                {activeHit + 1} of {hits.length}
                {searching ? '…' : ''}
              </span>
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                aria-label="Previous match"
                title="Previous match (Shift+Enter)"
                onClick={() => step(-1)}
              >
                <ChevronLeft />
              </Button>
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                aria-label="Next match"
                title="Next match (Enter)"
                onClick={() => step(1)}
              >
                <ChevronRight />
              </Button>
            </>
          ) : hits && !searching ? (
            <span className="text-muted-foreground text-xs whitespace-nowrap">no matches</span>
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

      {/* A rejected annotation used to vanish without a word: the mark was
          never drawn and nothing said why, which is indistinguishable from a
          tool that does not work. */}
      {annotationError ? (
        <Alert variant="destructive" className="mb-2">
          <CircleAlert />
          <AlertTitle>That mark was not saved</AlertTitle>
          <AlertDescription className="flex items-center justify-between gap-3">
            <span>{annotationError}</span>
            <Button size="sm" variant="outline" onClick={() => setAnnotationError(null)}>
              Dismiss
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="flex min-h-0 flex-1 gap-2">
        {rail && doc ? (
          <nav
            aria-label="Pages"
            className="bg-card hidden w-44 flex-none flex-col overflow-hidden rounded-xl border lg:flex"
          >
            {outline.length > 0 || hits !== null ? (
              <div className="flex gap-1 border-b p-1.5">
                <Button
                  variant={rail === 'thumbnails' ? 'secondary' : 'ghost'}
                  size="xs"
                  className="flex-1"
                  onClick={() => setRail('thumbnails')}
                >
                  <Rows3 />
                  Pages
                </Button>
                {outline.length > 0 ? (
                  <Button
                    variant={rail === 'outline' ? 'secondary' : 'ghost'}
                    size="xs"
                    className="flex-1"
                    onClick={() => setRail('outline')}
                  >
                    Contents
                  </Button>
                ) : null}
                {hits !== null ? (
                  <Button
                    variant={rail === 'search' ? 'secondary' : 'ghost'}
                    size="xs"
                    className="flex-1"
                    onClick={() => setRail('search')}
                  >
                    Results
                  </Button>
                ) : null}
              </div>
            ) : null}

            <div className="min-h-0 flex-1">
              {rail === 'search' && hits !== null ? (
                <SearchRail
                  hits={hits}
                  active={activeHit}
                  searching={searching}
                  onGo={goToHit}
                />
              ) : rail === 'outline' && outline.length > 0 ? (
                <OutlineRail items={outline} onGo={goTo} />
              ) : (
                <ThumbnailRail
                  doc={doc}
                  pageCount={doc.pageCount}
                  current={current}
                  onGo={goTo}
                />
              )}
            </div>
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
            layout.map((size, index) => (
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
