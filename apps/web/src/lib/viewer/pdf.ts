import type { Rect } from '@ecm/domain';

/**
 * The viewer seam (PDF-VIEWER.md §7).
 *
 * Everything above this file talks to `OpenDocument`; only this file knows that
 * PDF.js exists. That boundary is the whole point of the exercise — Dokmee's own
 * integration with Apryse was eight options and six member accesses, and the
 * lesson is that an interface this small is what keeps an engine replaceable.
 * Swapping in pdfium, or a server-side rasteriser, is a second implementation
 * of this file.
 */

export interface PageSize {
  /** CSS pixels at the requested scale and rotation. */
  width: number;
  height: number;
}

export interface RenderedPage extends PageSize {
  /** Viewport pixels → PDF user space (points, origin bottom-left). */
  toPdf(x: number, y: number): [number, number];
  /** PDF user space → viewport pixels. */
  toViewport(x: number, y: number): [number, number];
}

export interface SearchHit {
  /** 0-based. */
  page: number;
  /** Character offsets into the page's text, which is what a hit *is*. */
  start: number;
  end: number;
  /** In PDF user space, so a hit survives a zoom or a rotation. */
  rects: Rect[];
  /** The matched text with a little context either side. */
  snippet: string;
}

export interface SearchOptions {
  caseSensitive?: boolean;
  /** Called as each page is finished, so results can be shown while the rest run. */
  onPage?: (progress: { page: number; pageCount: number; hits: SearchHit[] }) => void;
  /** Abandons the walk; a superseded query should not keep reading pages. */
  signal?: AbortSignal;
}

/**
 * One page's text as a single string, plus the geometry of any range of it.
 *
 * This is the primitive Apryse exposes as `getTextPosition(page, start, end)`,
 * recovered in PDF-VIEWER.md §8: its page text data carries eight numbers per
 * character — a quad each — and a range of text becomes geometry by slicing
 * that array between `8 * start` and `8 * end`. Everything that has to point at
 * text is built on it: a search hit, a highlight, an underline, a strike-out.
 *
 * PDF.js gives a position and width per *item* (a run of glyphs), not per
 * character, so `quads` interpolates within an item. That is exact at an item's
 * edges and off by a fraction of a character width inside it — against the
 * whole-item box this replaces, which was wrong by whole words.
 */
export interface PageText {
  text: string;
  /** Quads for `[start, end)`, eight numbers each: UL, UR, LL, LR. */
  quads(start: number, end: number): number[];
  /** The same quads as bounding boxes, one per line of the range. */
  rects(start: number, end: number): Rect[];
}

export interface OutlineItem {
  title: string;
  page: number | null;
  children: OutlineItem[];
}

export interface RenderOptions {
  scale: number;
  /** Degrees, a multiple of 90. Added to the page's own rotation. */
  rotation: number;
}

export interface OpenDocument {
  readonly pageCount: number;
  /** Size without rendering, for laying out a page that is not drawn yet. */
  size(page: number, options: RenderOptions): Promise<PageSize>;
  render(
    page: number,
    canvas: HTMLCanvasElement,
    options: RenderOptions,
  ): Promise<RenderedPage>;
  /** Draw the selectable text layer into `container`. */
  renderText(
    page: number,
    container: HTMLElement,
    options: RenderOptions,
  ): Promise<void>;
  /** The page's text and the geometry of any range of it. Cached per page. */
  textOf(page: number): Promise<PageText>;
  search(query: string, options?: SearchOptions): Promise<SearchHit[]>;
  outline(): Promise<OutlineItem[]>;
  destroy(): void;
}

// --- PDF.js implementation ------------------------------------------------

type PdfJs = typeof import('pdfjs-dist');

let lib: PdfJs | null = null;

interface Cancellable {
  cancel(): void;
  promise: Promise<void>;
}

interface Job<T> {
  run: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (cause: unknown) => void;
}

interface Queue {
  busy: boolean;
  /** At most one waiting job: an older one would draw a bitmap nobody wants. */
  next: Job<never> | null;
}

const queues = new WeakMap<HTMLCanvasElement, Queue>();

/**
 * Serialise work on one canvas, keeping only the newest waiting request.
 *
 * PDF.js enforces "one render per canvas" on the canvas itself, so the registry
 * has to live there too — per document is not enough, because React's
 * development double invoke mounts the viewer twice and two renders of one page
 * onto one canvas is exactly the case that breaks.
 *
 * It queues rather than cancels, which is the opposite of what this code did
 * first. Cancelling looks right — why draw a bitmap that is already stale? —
 * but PDF.js tears a page's render intent down asynchronously, and a
 * replacement render started on that same page afterwards waits for operators
 * the worker will never send: it neither resolves nor rejects. That is how the
 * viewer came to show three blank pages with nothing in the console. Apryse
 * reached the same conclusion (PDF-VIEWER.md §8): when a page is already
 * drawing it keeps a *single* pending request and runs it when the current one
 * finishes, with no cancellation anywhere in the path.
 */
function enqueue<T>(canvas: HTMLCanvasElement, run: () => Promise<T>): Promise<T> {
  let queue = queues.get(canvas);
  if (!queue) {
    queue = { busy: false, next: null };
    queues.set(canvas, queue);
  }
  const q = queue;

  return new Promise<T>((resolve, reject) => {
    const job = { run, resolve, reject } as unknown as Job<never>;
    // Whatever was waiting is now out of date; tell its caller so, in the same
    // terms PDF.js uses for a cancelled render.
    q.next?.reject(superseded());
    q.next = job;
    if (!q.busy) void pump(q);
  });
}

async function pump(q: Queue): Promise<void> {
  q.busy = true;
  try {
    while (q.next) {
      const job = q.next;
      q.next = null;
      try {
        job.resolve(await job.run());
      } catch (cause) {
        job.reject(cause);
      }
    }
  } finally {
    q.busy = false;
  }
}

function superseded(): Error {
  const error = new Error('Rendering superseded by a newer request');
  // The component tells "superseded" from "broken" by name, and this is the
  // name PDF.js gives the same situation.
  error.name = 'RenderingCancelledException';
  return error;
}

/**
 * Was this render superseded rather than broken?
 *
 * The caller needs to tell the two apart: a superseded render is the normal
 * outcome of zooming while a page is still drawing, and reporting it as a
 * failure is how a working viewer comes to look like a broken one.
 */
export function isRenderCancelled(cause: unknown): boolean {
  return (
    typeof cause === 'object' &&
    cause !== null &&
    (cause as { name?: string }).name === 'RenderingCancelledException'
  );
}

/**
 * Loaded on first use rather than imported at module scope: PDF.js reaches for
 * `window` and `document`, so importing it eagerly breaks server rendering of
 * any page that merely links to the viewer.
 */
async function pdfjs(): Promise<PdfJs> {
  if (!lib) {
    const loaded = await import('pdfjs-dist');
    // The parser runs in a worker, fetched by URL at run time — staged into
    // public/ by scripts/copy-pdfjs-assets.mjs.
    loaded.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs';
    lib = loaded;
  }
  return lib;
}

export interface OpenOptions {
  url: string;
  /** Called with 0..1 while the file downloads. */
  onProgress?: (fraction: number) => void;
}

export async function openPdf({ url, onProgress }: OpenOptions): Promise<OpenDocument> {
  const { getDocument, TextLayer } = await pdfjs();

  const task = getDocument({
    url,
    // The session is a first-party cookie and the file route checks rights on
    // every request, so the worker's fetch has to carry credentials.
    withCredentials: true,
    // Assets staged next to the worker. Without cMaps CJK text renders blank;
    // without the standard fonts, a PDF that embeds none falls back to a
    // substitute with the wrong metrics; without the WASM codecs a JPEG 2000
    // scan — which is most scanned paper — does not decode at all.
    cMapUrl: '/pdfjs/cmaps/',
    cMapPacked: true,
    standardFontDataUrl: '/pdfjs/standard_fonts/',
    wasmUrl: '/pdfjs/wasm/',
    iccUrl: '/pdfjs/iccs/',
  });

  if (onProgress) {
    task.onProgress = ({ loaded, total }: { loaded: number; total: number }) => {
      onProgress(total > 0 ? Math.min(1, loaded / total) : 0);
    };
  }

  const doc = await task.promise;

  // `getPage` is not free on a large document, so pages are cached as they are
  // first touched rather than walked up front.
  const pages = new Map<number, Promise<Awaited<ReturnType<typeof doc.getPage>>>>();
  /** This document's running renders, so `destroy` can stop them. */
  const inflight = new Set<Cancellable>();
  /** Page text, built once: it is read by search and by every markup gesture. */
  const texts = new Map<number, Promise<PageText>>();

  function page(index: number) {
    let p = pages.get(index);
    if (!p) {
      p = doc.getPage(index + 1);
      pages.set(index, p);
    }
    return p;
  }

  interface TextItem {
    str?: string;
    transform?: number[];
    width?: number;
    height?: number;
    hasEOL?: boolean;
  }

  /**
   * Build the page's text index: the string, and enough geometry per run of
   * glyphs to place any character range back on the page.
   */
  async function buildText(index: number): Promise<PageText> {
    const p = await page(index);
    const content = await p.getTextContent({ includeMarkedContent: false });
    const items = content.items as TextItem[];

    let text = '';
    const runs: Array<{ from: number; to: number; item: TextItem }> = [];

    for (const item of items) {
      const str = item.str ?? '';
      if (str.length > 0) {
        runs.push({ from: text.length, to: text.length + str.length, item });
        text += str;
      }
      // PDF.js marks where a visual line ends. Without a break here the page
      // reads as one long line, and a search for two words matches a pair that
      // only looks adjacent because one ends a line and the other starts the
      // next.
      if (item.hasEOL) text += '\n';
    }

    function quads(start: number, end: number): number[] {
      if (!(end > start)) return [];
      const out: number[] = [];

      for (const run of runs) {
        if (run.to <= start || run.from >= end) continue;
        const t = run.item.transform;
        if (!t || t.length < 6) continue;

        const [a, b, , d, e, f] = t as [number, number, number, number, number, number];
        const length = run.to - run.from;
        const width = run.item.width ?? 0;
        const height = run.item.height || Math.abs(d) || 10;

        // Where in this run the wanted range starts and ends, as a distance
        // along the baseline. Interpolating by character count is exact at the
        // run's edges and off by a fraction of a character inside it — PDF.js
        // reports no per-character advance, so this is the honest limit of the
        // approach, and still an item's worth tighter than the box it replaces.
        const from = (Math.max(start, run.from) - run.from) / length;
        const to = (Math.min(end, run.to) - run.from) / length;
        const near = width * from;
        const far = width * to;

        // The text matrix carries the rotation, so the quad is built from the
        // baseline direction and its perpendicular rather than from axis-aligned
        // minimums: rotated text then gets a rotated quad instead of a box that
        // swallows the whole line.
        const norm = Math.hypot(a, b) || 1;
        const ux = a / norm;
        const uy = b / norm;
        const vx = -uy;
        const vy = ux;
        // Typical proportions of a font's ascent and descent about the
        // baseline; a highlight has to cover the glyphs, not just hug them.
        const up = height * 0.78;
        const down = height * 0.22;
        const at = (along: number, off: number): [number, number] => [
          e + ux * along + vx * off,
          f + uy * along + vy * off,
        ];

        const [ulx, uly] = at(near, up);
        const [urx, ury] = at(far, up);
        const [llx, lly] = at(near, -down);
        const [lrx, lry] = at(far, -down);
        // XFDF quadpoint order, the one Acrobat writes: UL, UR, LL, LR.
        out.push(ulx, uly, urx, ury, llx, lly, lrx, lry);
      }

      return out;
    }

    return {
      text,
      quads,
      rects(start, end) {
        const flat = quads(start, end);
        const out: Rect[] = [];
        for (let i = 0; i + 7 < flat.length; i += 8) {
          const xs = [flat[i]!, flat[i + 2]!, flat[i + 4]!, flat[i + 6]!];
          const ys = [flat[i + 1]!, flat[i + 3]!, flat[i + 5]!, flat[i + 7]!];
          out.push({
            x1: Math.min(...xs),
            y1: Math.min(...ys),
            x2: Math.max(...xs),
            y2: Math.max(...ys),
          });
        }
        return out;
      },
    };
  }

  function textOf(index: number): Promise<PageText> {
    let t = texts.get(index);
    if (!t) {
      t = buildText(index);
      texts.set(index, t);
    }
    return t;
  }

  /** One page onto one canvas. Only ever called from the canvas's queue. */
  async function draw(
    index: number,
    canvas: HTMLCanvasElement,
    options: RenderOptions,
  ): Promise<RenderedPage> {
    const p = await page(index);
    const vp = viewportFor(p, options);

    // Draw at device resolution and scale back down with CSS, or text and
    // hairlines are visibly soft on any HiDPI screen.
    const dpr = typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1;
    canvas.width = Math.floor(vp.width * dpr);
    canvas.height = Math.floor(vp.height * dpr);
    canvas.style.width = `${Math.floor(vp.width)}px`;
    canvas.style.height = `${Math.floor(vp.height)}px`;

    const renderTask = p.render({
      canvas,
      viewport: vp,
      transform: dpr === 1 ? undefined : [dpr, 0, 0, dpr, 0, 0],
    });
    inflight.add(renderTask);
    try {
      await renderTask.promise;
    } finally {
      inflight.delete(renderTask);
    }

    return {
      width: vp.width,
      height: vp.height,
      toPdf: (x, y) => vp.convertToPdfPoint(x, y) as [number, number],
      toViewport: (x, y) => vp.convertToViewportPoint(x, y) as [number, number],
    };
  }

  function viewportFor(
    p: Awaited<ReturnType<typeof doc.getPage>>,
    { scale, rotation }: RenderOptions,
  ) {
    // Rotation is added to whatever the page itself declares, so a page that
    // arrives sideways starts upright and the control still turns it.
    return p.getViewport({ scale, rotation: (p.rotate + rotation) % 360 });
  }

  return {
    pageCount: doc.numPages,

    async size(index, options) {
      const vp = viewportFor(await page(index), options);
      return { width: vp.width, height: vp.height };
    },

    render(index, canvas, options) {
      return enqueue(canvas, () => draw(index, canvas, options));
    },

    async renderText(index, container, options) {
      const p = await page(index);
      const vp = viewportFor(p, options);
      container.replaceChildren();

      // The scale reaches the text layer through CSS, not through the markup:
      // PDF.js writes each span's height as `--font-height` in unscaled points
      // and leaves the stylesheet to multiply it by `--total-scale-factor`
      // (globals.css says what the rest of that contract is). Skip this and
      // the spans fall back to the inherited font size, which is how a
      // selection — and every highlight made from one — comes to sit off the
      // text it was drawn over.
      //
      // `userUnit` is the page's own unit scale, which `viewport.scale` leaves
      // out and `viewport.width` includes; a page that declares one is rare but
      // renders at the wrong size for exactly as long as it is forgotten here.
      const style = container.style;
      style.setProperty('--total-scale-factor', String(vp.scale * vp.userUnit));
      // The layer sizes itself with a `round()` to whole device pixels, whose
      // step comes from these. They are not optional: left undefined, the
      // expression is invalid and the layer keeps whatever size it had, which
      // on a rotated page is the wrong one.
      style.setProperty('--scale-round-x', '1px');
      style.setProperty('--scale-round-y', '1px');

      const layer = new TextLayer({
        textContentSource: p.streamTextContent({ includeMarkedContent: false }),
        container,
        viewport: vp,
      });
      await layer.render();
    },

    textOf,

    /**
     * Free-text search across every page.
     *
     * A hit is a character range in a page's text, and its geometry comes from
     * the page's text index — so a highlight covers the match and not the run
     * of glyphs that happens to contain it.
     *
     * Pages are reported as they finish (`onPage`) and the walk yields to the
     * event loop between them. That is the difference between a search that
     * shows its first results immediately and one that holds the tab still
     * until a 400-page scan is done — Apryse streams the same way, through a
     * per-result callback with page and done markers (PDF-VIEWER.md §8).
     */
    async search(query, options) {
      const caseSensitive = options?.caseSensitive ?? false;
      const needle = caseSensitive ? query : query.toLowerCase();
      if (!needle.trim()) return [];

      const all: SearchHit[] = [];
      for (let index = 0; index < doc.numPages; index++) {
        if (options?.signal?.aborted) break;

        const pageText = await textOf(index);
        const haystack = caseSensitive ? pageText.text : pageText.text.toLowerCase();
        const hits: SearchHit[] = [];

        let at = haystack.indexOf(needle);
        while (at >= 0) {
          const end = at + needle.length;
          hits.push({
            page: index,
            start: at,
            end,
            rects: pageText.rects(at, end),
            snippet: pageText.text.slice(Math.max(0, at - 40), end + 40).replace(/\s+/g, ' ').trim(),
          });
          if (all.length + hits.length >= 2000) break;
          at = haystack.indexOf(needle, end);
        }

        all.push(...hits);
        options?.onPage?.({ page: index, pageCount: doc.numPages, hits });
        if (all.length >= 2000) break;
        // Hand the main thread back between pages so results paint as they are
        // found and the toolbar stays responsive.
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      return all;
    },

    async outline() {
      const raw = (await doc.getOutline()) as Array<{
        title: string;
        dest: unknown;
        items?: unknown[];
      }> | null;
      if (!raw) return [];

      async function pageOf(dest: unknown): Promise<number | null> {
        try {
          const resolved =
            typeof dest === 'string' ? await doc.getDestination(dest) : dest;
          if (!Array.isArray(resolved) || resolved.length === 0) return null;
          const index = await doc.getPageIndex(resolved[0] as never);
          return typeof index === 'number' ? index : null;
        } catch {
          // A broken destination is common in the wild; an entry that cannot be
          // resolved still belongs in the tree, just without a target.
          return null;
        }
      }

      async function walk(nodes: typeof raw): Promise<OutlineItem[]> {
        const out: OutlineItem[] = [];
        for (const node of nodes ?? []) {
          out.push({
            title: node.title,
            page: await pageOf(node.dest),
            children: await walk((node.items ?? []) as typeof raw),
          });
        }
        return out;
      }

      return walk(raw);
    },

    destroy() {
      for (const running of inflight) running.cancel();
      inflight.clear();
      // On the loading task, not the document: this aborts any request still in
      // flight *and* terminates the worker. Calling the document's `cleanup()`
      // instead would leave a worker behind for every document ever opened.
      void task.destroy();
      pages.clear();
      texts.clear();
    },
  };
}
