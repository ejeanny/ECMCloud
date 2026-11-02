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
  /** In PDF user space, so a hit survives a zoom or a rotation. */
  rects: Rect[];
  /** The matched text with a little context either side. */
  snippet: string;
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
  search(query: string, options?: { caseSensitive?: boolean }): Promise<SearchHit[]>;
  outline(): Promise<OutlineItem[]>;
  destroy(): void;
}

// --- PDF.js implementation ------------------------------------------------

type PdfJs = typeof import('pdfjs-dist');

let lib: PdfJs | null = null;

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
  function page(index: number) {
    let p = pages.get(index);
    if (!p) {
      p = doc.getPage(index + 1);
      pages.set(index, p);
    }
    return p;
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

    async render(index, canvas, options) {
      const p = await page(index);
      const vp = viewportFor(p, options);

      // Draw at device resolution and scale back down with CSS, or text and
      // hairlines are visibly soft on any HiDPI screen.
      const dpr = typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1;
      canvas.width = Math.floor(vp.width * dpr);
      canvas.height = Math.floor(vp.height * dpr);
      canvas.style.width = `${Math.floor(vp.width)}px`;
      canvas.style.height = `${Math.floor(vp.height)}px`;

      await p.render({
        canvas,
        viewport: vp,
        transform: dpr === 1 ? undefined : [dpr, 0, 0, dpr, 0, 0],
      }).promise;

      return {
        width: vp.width,
        height: vp.height,
        toPdf: (x, y) => vp.convertToPdfPoint(x, y) as [number, number],
        toViewport: (x, y) => vp.convertToViewportPoint(x, y) as [number, number],
      };
    },

    async renderText(index, container, options) {
      const p = await page(index);
      const vp = viewportFor(p, options);
      container.replaceChildren();
      container.style.width = `${Math.floor(vp.width)}px`;
      container.style.height = `${Math.floor(vp.height)}px`;

      const layer = new TextLayer({
        textContentSource: p.streamTextContent({ includeMarkedContent: false }),
        container,
        viewport: vp,
      });
      await layer.render();
    },

    /**
     * Free-text search across every page.
     *
     * Hit rectangles are the bounding boxes of the *text items* that contain the
     * match, not of the matched glyphs: PDF.js reports a position and width per
     * item, and splitting an item to the character would mean re-measuring the
     * font. The result is a highlight that can be a little generous at the ends
     * of a match — accurate enough to find something, and honest about what it
     * is rather than silently wrong.
     */
    async search(query, options) {
      const needle = options?.caseSensitive ? query : query.toLowerCase();
      if (!needle.trim()) return [];

      const hits: SearchHit[] = [];
      for (let index = 0; index < doc.numPages; index++) {
        const p = await page(index);
        const content = await p.getTextContent({ includeMarkedContent: false });

        // One string per page plus a map back to the item each character came
        // from, so a match that straddles two items resolves to both.
        let text = '';
        const owner: number[] = [];
        const items = content.items as Array<{
          str?: string;
          transform?: number[];
          width?: number;
          height?: number;
        }>;
        items.forEach((item, i) => {
          const str = item.str ?? '';
          text += str;
          for (let c = 0; c < str.length; c++) owner.push(i);
        });

        const haystack = options?.caseSensitive ? text : text.toLowerCase();
        let from = 0;
        for (;;) {
          const at = haystack.indexOf(needle, from);
          if (at < 0) break;
          from = at + needle.length;

          const touched = new Set(owner.slice(at, at + needle.length));
          const rects: Rect[] = [];
          for (const i of touched) {
            const item = items[i];
            if (!item?.transform) continue;
            // transform is [a,b,c,d,e,f]; e,f is the baseline origin in PDF
            // space and d carries the glyph height for unrotated text.
            const [, , , d, e, f] = item.transform as [
              number, number, number, number, number, number,
            ];
            const height = item.height || Math.abs(d) || 10;
            rects.push({ x1: e, y1: f, x2: e + (item.width ?? 0), y2: f + height });
          }
          if (rects.length === 0) continue;

          hits.push({
            page: index,
            rects,
            snippet: text.slice(Math.max(0, at - 32), at + needle.length + 32).trim(),
          });
          if (hits.length >= 500) return hits;
        }
      }
      return hits;
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
      // On the loading task, not the document: this aborts any request still in
      // flight *and* terminates the worker. Calling the document's `cleanup()`
      // instead would leave a worker behind for every document ever opened.
      void task.destroy();
      pages.clear();
    },
  };
}
