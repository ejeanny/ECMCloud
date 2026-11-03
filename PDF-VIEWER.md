# The document viewer: what Dokmee uses, and how to build your own

Dokmee's viewer is **Apryse WebViewer** (the product formerly sold as PDFTron
WebViewer), licensed OEM. This document records the *seam* — how Dokmee drives
it, and what it asks of the server — so the viewer can be replaced by an
implementation of your own without changing the host application around it.

Scope, stated plainly: what follows is the integration contract and the
functional surface, recovered from Dokmee's own shipped code. It is not a
description of how Apryse's rendering engine works internally. That engine is
their product, it is not an interface, and reading it would not help — a PDF
renderer is built from the PDF specification, not from someone else's compiled
output. §7 is the build path that actually works.

Claims are tagged [observed] (read directly out of a shipped artifact),
[inferred] (a reasonable reading of observed facts), or [unknown].

---

## 1. What is actually shipped

Under `webApp\Scripts\libs\` [observed]:

| Artifact | Size | Role |
|---|---|---|
| `webviewer.min.js` | 27.8 KB | loader: validates options, builds an iframe URL, resolves the instance |
| `public/ui/webviewer-ui.min.js` | 0.47 MB | the React UI, running **inside an iframe** |
| `public/ui/webviewer-ui.min.js.map` | 2.05 MB | source map, shipped to production |
| `public/core/webviewer-core.min.js` | 2.62 MB | document/annotation/viewport orchestration |
| `public/core/pdf/{full,lean}[/optimized]/PDFNetC*.wasm` | 2.9–5.9 MB each | the rendering engine, four build variants |
| `public/core/pdf/*/PDFNetThreadedWasm.*` | 3.0–5.9 MB | threaded (SharedArrayBuffer) variants |
| `public/core/pdf/*/PDFNetC.*.js.mem` | 3.4–9.4 MB | asm.js memory images (legacy fallback) |
| `public/core/pdf/pdfnet.res` | 1.68 MB | engine resources — fonts/CMaps [inferred] |

And server-side, in `webApp\bin\` [observed]: `PDFNet.dll` (57 MB),
`Spire.Pdf.dll` (20 MB), `iTextSharp.dll` (3.5 MB), plus `Spire.Doc`,
`Spire.XLS`, `Spire.Presentation` and `webApp\PDFTron\CADModuleWindows\…\pdftronCADConvert.dll`.

So there are **four** PDF stacks in the product, not one [observed]. Apryse
drives the viewer and the document manipulation; Spire handles Office formats;
iTextSharp appears only through report-building types (`PdfWriter`, `PdfPTable`,
`PdfPCell`, `PdfContentByte`, `PdfPageEventHelper`) and is [inferred] used for
generated reports, not for document display.

**Architecture** [observed]: the loader builds
`uiPath = options.path + options.uiPath`, appends
`this._getHTML5OptionsURL()`, and loads that into an `<iframe>` — the loader
contains `ui/index.html` as a literal, with 13 `iframe` and 13
`createElement` references. Configuration therefore crosses into the UI **as
query-string parameters**; observed fragments include `&user=`, `&custom=`,
`&toolbar=`, `&a=` (admin flag), and `+!!` boolean coercions for `fullAPI` and
its neighbours. The UI inside the frame loads `webviewer-core`, which starts
the PDFNet WASM module in a worker [inferred].

Three entry points ship side by side [observed]: `public/ui/index.html` (642 B),
`index-wc.html` (a web-component variant — so the iframe is not strictly
required even in the original) and `index.aspx`. Your replacement does not have
to use an iframe at all; see the consequence in §4.

---

## 2. The constructor contract

Two call sites in `Scripts/libs/main.182c8f165c2389f4.js` (the 19/08/2026
build) [observed]. Both are `await WebViewer(options, hostElement)`.

**Site A — the main document viewer** (offset 600470):

```js
instance = await WebViewer({
  path:                <base>/public,   // production: href up to '#', + baseHref + '/public'
  licenseKey:          <OEM key>,
  webviewerServerURL:  serverUrl || undefined,  // from fileSystemSvc.GetPDFTronWebViewerServerUrl()
  fullAPI:             true,
  loadAsPDF:           true,
  forceClientSideInit: !serverUrl,
  disabledElements:    [ /* 17 entries, see below */ ],
}, this.viewerHost.nativeElement);

instance.UI.setTheme(/* … */);
```

**Site B — a second viewer, CAD-capable** (offset 1752888):

```js
WebViewer({
  path:                production ? base + baseHref + '/public' : '/public',
  webviewerServerURL:  serverUrl,
  licenseKey:          'DOKMEE:OEM:See Agreement::B+:AMS(20280615):…',  // literal
  fullAPI:             true,
  loadAsPDF:           true,
  isReadOnly:          this.isRestrictedReadOnly,
  forceClientSideInit: true,
}, hostEl).then(async instance => { /* … */ });
```

Teardown, site B [observed]: `document.body.classList.remove('pdftron-viewer-open')`
then `instance.UI.dispose()`. It also injects a `<style>` element that hides
`div[data-element="formsToolsGroupedItems"] .Icon` — i.e. CSS is used to suppress
chrome that `disabledElements` did not reach.

**The four options that carry the real decisions** [observed]:

- `fullAPI: true` loads the heavyweight engine build (the `full/` WASM, not
  `lean/`) so the complete document API is available client-side.
- `loadAsPDF: true` converts anything non-PDF to PDF before display — this is
  why one viewer can show Word, Excel and email.
- `webviewerServerURL` optionally points at **WebViewer Server**, a separate
  server-side rendering service. When Dokmee's endpoint returns nothing,
  `forceClientSideInit` becomes `true` and everything renders in the browser.
  So both topologies are supported and the client picks at runtime.
- `isReadOnly` is wired to Dokmee's own `isRestrictedReadOnly`, so the viewer's
  read-only state is driven by the permission model, not by the viewer.

**`disabledElements`** — 17 entries. Resolvable as plain literals: `toolsHeader`,
`menuOverlay`, `toggleNotesButton`, `searchButton`, `panToolButton`. The
remaining 12 are indices into the obfuscator's string table
(`_0x555717(0x395a)` and similar) [unknown]. Resolving them means executing the
bundle's string-rotation routine, which I will not run — it is untrusted code,
and the list is cosmetic: it says which stock chrome Dokmee hides, which your
own UI simply never builds.

**The full option vocabulary** — 70 keys, read from the loader's own defaults
object [observed]. Worth having, because it is the total configuration surface
the host app could depend on:

```
accessibleMode, additionalTranslations, annotationAdmin, annotationUser,
autoExpandOutlines, backendType, backgroundColor, config, css, custom,
disableI18n, disableLogs, disableMultiViewerComparison, disableObjectURLBlobs,
disableToolGroupReordering, disableVirtualDisplayMode, disableWebsockets,
disabledElements, documentId, documentType, documentXFDFRetriever,
enableAnnotationNumbering, enableAnnotations, enableAzureWorkaround,
enableFilePicker, enableMeasurement, enableOfficeEditing, enableOfflineMode,
enableOptimizedWorkers, enableReadOnlyMode, enableRedaction,
enableViewStateAnnotations, encryption, extension, externalPath,
fallbackToClientSide, filename, forceClientSideInit, fullAPI,
hideAnnotationPanel, hideDetachedReplies, isAdminUser, isReadOnly, l,
licenseKey, loadAsPDF, mobileRedirect, notesInLeftPanel, officeEditorOptions,
path, pdfBackend, preloadPDFWorker, preloadWorker, selectAnnotationOnCreation,
serverUrl, serverUrlHeaders, showInvalidBookmarks, showLocalFilePicker,
showToolbarControl, singleServerMode, spreadsheetEditorOptions, startOffline,
streaming, type, ui, uiConfig, uiPath, useDownloader,
webviewerServerRangeRequests, workerTransportPromise, xdomainProxyUrl
```

Dokmee sets 8 of those 70. **That is the useful finding**: the surface you must
reproduce is about an eighth of the one Apryse exposes.

---

## 3. The instance surface Dokmee uses

Observed member accesses on the resolved instance: `instance.UI.setTheme`,
`instance.UI.dispose`, `instance.Core.documentViewer`,
`instance.Core.annotationManager`, `loadDocument`, `setToolMode`.

That is the whole consumed API [observed, with the caveat that the bundle is
mangled and a dynamically-computed member access would not appear in this
search — so treat it as a lower bound rather than a closed set].

---

## 4. The server contract

**Configuration** [observed] — three server methods and one config key:
`GetPDFTronWebViewerServerUrl`, `GetPDFTronLicenseKey`, `GetPDFTronServerURL`,
and `PDFTron_WebViewer_Server_URL` in configuration.

**Annotations travel as XFDF** [observed]. The evidence is
`FDFDoc.CreateFromXFDF` and `PDFDoc.FDFUpdate` on the server, alongside:

```
UpdateAnnotationsForDocument   UpdateAnnotationsAsync   SaveWFAnnotationAsync
get_AnnotationsData            set_AnnotationsData      HasAnnotations
BurnAnnotationsToFile          RefreshAnnotAppearances  GetNumAnnots / GetAnnot
AnnotRemove                    get_BurnedAnnotationList
BroadcastWfAnnotationsApplied
```

So: the viewer emits XFDF, Dokmee stores it **beside** the document rather than
in it, and merges it into the PDF only when producing an output file. That is a
good design and worth keeping — the original bytes stay untouched, annotations
stay queryable and revocable, and "burn" is a deliberate step. `Broadcast…`
[inferred] pushes annotation changes to other viewers over the SignalR hub.

This is the single most important thing to preserve: **XFDF is the contract.**
Keep it and your annotations remain readable by Acrobat and every other PDF
tool; invent your own JSON and you are locked in forever.

**A note on the iframe** [observed]: because the stock UI runs in an iframe, the
host app talks to it through `postMessage` — four references in the loader, and
Dokmee's own bundle contains a `window.addEventListener('message', …)` handler
that posts `{type, value}` replies back to `event.source`. So a document
identifier and its data cross a frame boundary in both directions. If you build
your viewer as ordinary in-page components, this entire layer disappears — a
simplification, and one less place for a message to arrive from an origin you
did not expect.

---

## 5. What the 57 MB on the server is actually doing

Recovered from `Dokmee.Ecm.Web.dll` [observed]. This is the part people
underestimate when they say "I'll just swap the viewer":

**Conversion** — `ConvertFileToPDF`, `ConvertToPdf`, `OfficeToPDF`,
`OfficeToPDFOptions`, `ConvertCadToPdfAsync`, `ConvertPdfFileToOriginalFormat`,
`ConvertSourceFileToPdfForLlm`, `NeedsPdfConversionForLlm`,
`ExtensionsRequiringPdfConversionForLlm`, `ModelRequiresPdfForOfficeAndEmail`.

**Watermarking** — `ApplyWatermarkApryseAsync`, `CreateWatermark`,
`BuildWatermarkDrawing`, `SetWatermarkLabelPosition`, `WatermarkFont`,
`WatermarkSize`, `WatermarkLocation`, `WatermarkLabelLocation`,
`IsWatermarkApplicable`, `GetWatermarkByCabinetIdAsync`,
`CreateDownloadResponseWithWaterMarkAsync` /
`CreateDownloadResponseWithoutWaterMarkAsync`,
`CleanUpPreviouslyWatermarkedFiles`, `UpdateExtAfterWatermarkApplied`.

Note the shape: watermarks are **per cabinet**, applied at download time, and
the watermarked file is cached and later cleaned up.

**Stamps** — a whole subsystem: `Stamper`, `StampImage`, `RepeatImageStamp`,
`StampOn`, `StampService`, `StampOpacityService`, `CabinetStampController`,
`UserStampOpacityController`, `GetAllStampsForWorkflowActionAsync`,
`AddWorkflowActionStampAsync`, `GetWfActionStampByActionAsync`. Stamps bind to
**workflow actions** — approving a document applies its stamp.

**Page manipulation** — `InsertPagesToPDFFile`, `ExtractPdf`, `PageSet`,
`Flatten`, `FlattenSimpleFieldAncestor`, `ContentReplacer`, `ElementBuilder`,
`ElementWriter`.

**Text** — `TextExtractor`, `GetAsPDFText`, plus OCR scheduling
(`AddOCRServiceSchedulerAsync`, `GetOCRSettingAsync`, `ResendFilesToOCR`,
`OcrLanguage`, `SERVICE_AUTO_OCR`, `IgnoreOcredFilesInResend`).

Guards worth copying [observed]: `MAX_PDF_PAGES`, `GEMINI_PDF_MAX_BYTES`.

---

## 6. The licence key is in the client bundle

`licenseKey` is a **plaintext string literal in `main.*.js`**, shipped to every
browser [observed], in the form:

```
DOKMEE:OEM:See Agreement::B+:AMS(20280615):<60 hex characters>
```

`AMS(20280615)` [inferred] is a maintenance/expiry date of 2028-06-15. There is
also a server endpoint `GetPDFTronLicenseKey` — so one call site hard-codes the
key while the infrastructure to serve it exists, which [inferred] is drift
rather than design.

Two consequences:

1. **A real finding for Dokmee.** An OEM licence key readable by anyone who
   opens DevTools is a licence-compliance exposure, not a security hole in the
   usual sense. If you have a channel to them, it is worth reporting.
2. **It is not available to you.** The key is bound to Dokmee's OEM agreement.
   Reusing it would be licence misappropriation, and it is also pointless — it
   is scoped and dated. If you want Apryse, you buy Apryse; the point of §7 is
   that you do not have to.

---

## 7. Building your own

> **This is now built.** The viewer in `apps/web/src/components/viewer/` renders
> with PDF.js behind the seam in `apps/web/src/lib/viewer/pdf.ts`; annotations
> are stored by `apps/api/src/routers/annotation.ts`, serialised by
> `packages/domain/src/xfdf.ts`, and burned into the page content by
> `apps/api/src/burn.ts`. What follows is the reasoning it was built on, kept
> because the engine-replacement argument still holds — and because the long
> tail in the table below is still ahead.

Replacing this is three separate problems with very different difficulty. Be
honest about which is which.

### Rendering — solved, use PDF.js

**PDF.js** (Mozilla, Apache-2.0) renders PDF to canvas, gives you a selectable
text layer, search, outline/bookmarks, and AcroForm widgets. It is the engine
in Firefox; it is battle-tested on the real-world corpus of broken PDFs, which
is the only thing that matters. `pdfium` (Google, BSD-3) is the alternative when
you want native speed server-side — rasterising for thumbnails, say.

What you write yourself is the **viewer**, not the renderer: page virtualisation,
zoom/fit modes, rotation, a thumbnail rail, continuous vs single-page scroll.
That is a few hundred lines over PDF.js's page API, and it is the part worth
owning because it is where the product feel lives.

### Annotations — your code, their format

PDF.js *displays* annotations but does not author them. You implement the editor
layer: an absolutely-positioned overlay per page, hit-testing in PDF user space,
and tools for highlight / strike-out / ink / note / rectangle / text / redaction
box. Persist as **XFDF** (§4) — then Acrobat, Apryse and anything else can still
read what your users drew.

Keep Dokmee's split: annotations live next to the document and are merged only
on output. It means an annotation is never destructive and can carry its own
permissions, which is exactly what `Folders_Files_View_Versions`-style rights
need.

### Server-side manipulation — the long tail

| Operation | Open replacement | Honest assessment |
|---|---|---|
| Page insert/extract/merge/rotate | `pdf-lib` (MIT) | Straightforward |
| Watermark / stamp | `pdf-lib` | Straightforward; fonts need care |
| Burn annotations into the page | `pdf-lib` | **Done** — `apps/api/src/burn.ts` |
| Flatten form fields | `pdf-lib`, or `qpdf` | Moderate |
| Linearise / encrypt / repair | `qpdf` (Apache-2.0) | Solved, and better than rolling your own |
| Rasterise (thumbnails, previews) | `pdfium` via node bindings | Solved |
| Office → PDF | LibreOffice headless | Works well; needs a sandboxed worker and a process pool |
| Email (.msg/.eml) → PDF | your own renderer → HTML → PDF | Fiddly but unglamorous |
| OCR | Tesseract 5 | Good, not IRIS-good, on poor scans |
| **True redaction** (remove, not cover) | — | **Hard. Do not fake it.** |
| **CAD → PDF** | — | **No credible open equivalent.** |

The last two deserve emphasis. A redaction that draws a black rectangle over
text that is still in the content stream is a data breach with a progress bar;
if you cannot remove the glyphs and any copy in the OCR layer, do not ship the
feature. And CAD conversion is why Dokmee licensed a separate
`pdftronCADConvert.dll` — if you need it, licensing a converter is the rational
answer.

### The interface to build against

Define the seam yourself so the engine stays swappable — the mistake to avoid is
letting PDF.js types leak into your components:

```ts
export interface DocumentViewer {
  load(source: { url: string; headers?: Record<string, string> }): Promise<void>;
  readonly pageCount: number;
  goToPage(page: number): void;
  setZoom(zoom: number | 'fit-width' | 'fit-page'): void;
  rotate(quarterTurns: 1 | -1): void;
  search(query: string, opts?: { caseSensitive?: boolean; whole?: boolean }):
    AsyncIterable<{ page: number; rects: Rect[] }>;
  readonly annotations: AnnotationStore;  // import/exportXFDF, add, update, remove
  dispose(): void;
}
```

Dokmee's own integration is 8 options, 6 member accesses and an XFDF channel
(§2–§4). An interface of that size is a weekend's work to define and years of
freedom afterwards.

---

## 8. How search, text geometry and annotation drawing actually work

Recovered in a second pass, to answer three complaints about our own viewer:
annotations slow to appear, text markup unreliable, search with no navigation
and no visible highlight. The product ships its UI **source maps with
`sourcesContent` populated** — 597 original modules in `webviewer-ui.min.js.map`
alone, more across ~1 000 chunk maps — so the UI side is the vendor's own text,
not a reconstruction. The engine side is the API surface of
`webviewer-core.min.js` (2.62 MB, minified, no map).

### 8.1 One text index per page, with a quad per character

```
getTextPosition(pageNumber, start, end)   // → Promise<quad[]>
getSelectedTextQuads()                    // → { [pageNum]: quad[] }
```

`getTextPosition` loads the page's text data and slices a flat array of
coordinates between `8 * start` and `8 * end`, reading eight numbers per step
into `{x1,y1,x2,y2,x3,y3,x4,y4}`. So the page's text carries **one quad per
character**, and *any* range of text becomes geometry by slicing. It rejects
when `end <= start`.

This is the primitive everything else stands on: a search hit, a highlight, an
underline and a strike-out are all the same operation — a character range
turned into quads — which is why in Apryse they cannot disagree with each other.

**What we do.** `PageText` in `apps/web/src/lib/viewer/pdf.ts` is the same
interface over PDF.js, which reports a position and width per *run* of glyphs
rather than per character, so a range is interpolated within the run it falls
in: exact at a run's edges, off by a fraction of a character inside one. The
code it replaced used the whole run's bounding box, which was wrong by whole
words.

### 8.2 Search is a stream, with a result set and an active member

```
textSearchInit(searchValue, searchMode, isFullSearch, handleSearchResult)
getPageSearchResults(pageNumber)        clearSearchResults()
displaySearchResult(result)             displayAdditionalSearchResult(result)
getActiveSearchResult()                 setActiveSearchResult(result)
```

A result is `{ ambientStr, resultStr, resultStrStart, resultStrEnd, pageNum,
resultCode, quads }` — the match, its surrounding text, its character range,
its page, and its geometry — carried twice, once camelCase and once snake_case.
`resultCode` distinguishes a match from a **page** marker and a **done**
marker, which is how the callback reports progress rather than returning a
list: results arrive page by page while the walk continues.

The UI (`hooks/useSearch.js`) keeps `searchResults`, `activeSearchResult` and
`activeSearchResultIndex`, and listens for `searchResultsChanged`,
`activeSearchResultChanged` and `searchInProgress`; status is one of
`SEARCH_NOT_INITIATED`, `SEARCH_IN_PROGRESS`, `SEARCH_DONE`. Typing is
debounced by 500 ms. The engine defaults the active result to the first one.
Results are compared with `isSearchResultEqual`, not by object identity.

Two separate ideas are worth naming, because collapsing them is what makes a
search unusable: **display all the results** and **mark one of them active**.

**What we do.** `search()` takes `onPage` and an `AbortSignal`, reports each
page as it finishes and yields to the event loop between pages; the viewer
holds an active index, steps with Enter and Shift+Enter, wraps around, shows
"n of m", and scrolls the hit — not the top of its page — a third of the way
down. The active hit is drawn in a stronger colour with an outline.

### 8.3 Annotations are drawn per page, and requests coalesce

```
drawAnnotations({ pageNumber, overrideCanvas, majorRedraw, overrideContainer, namespace })
```

It draws onto a per-page 2D canvas — the `.auxiliary` canvas inside
`#pageContainer{N}` — and schedules like this: if no draw is in flight for that
page, draw now; if one is, store a **single** pending request, OR-ing
`majorRedraw` into whatever was already pending, and return the in-flight
promise. So many changes to one page collapse into one extra draw, and a
request never queues behind more than one other.

**What we do.** Annotations stay SVG (§7), which costs nothing to re-draw on
zoom, but the scheduling applies to *page rendering*, where we had the bug this
section was written to explain: a second `render()` on a canvas while the first
is in flight is refused by PDF.js, and cancelling the first then starting
another leaves a render that never settles. `enqueue` in `pdf.ts` now holds one
canvas's work in order and keeps only the newest waiting request — Apryse's
scheduling, arrived at from the same constraint.

---

## 8.4 One viewer for every format, because everything becomes a PDF

The single most consequential decision in Dokmee's viewer is not in the viewer.
It is `loadAsPDF: true` (§2): **nothing but PDF is ever displayed**. Word,
Excel, PowerPoint, email and scans are all converted first, and what the user
sees is always a PDF.

Confirmed in the shipped bundles [observed]:

| Where | What is there |
|---|---|
| `webviewer.min.js` | `loadAsPDF` among the 70 constructor options |
| `webviewer-core.min.js` | `loadAsPDF` ×11, `officeToPDFBuffer`, `officeToPDFOptions`, `getOfficeWorker`/`officeWorker` ×13, `OfficeEditor` ×259, `ElementBuilder`, `PageSize`, `image/png`, `image/jpeg`, `image/tiff` |
| `webApp\bin\` | `Spire.Doc`, `Spire.XLS`, `Spire.Presentation` beside `PDFNet.dll` |
| `Dokmee.Ecm.Web.dll` | `ConvertFileToPDF`, `OfficeToPDF`, `OfficeToPDFOptions`, `ConvertCadToPdfAsync`, `ConvertPdfFileToOriginalFormat` |

So conversion runs in **both** places: Office can be converted in the browser
by the WASM office worker (`officeToPDFBuffer`), and the server has Spire for
the same job plus CAD through `pdftronCADConvert.dll`. An image becomes a page
through PDFNet's `ElementBuilder`/`PageSize` — the same content-building API
the stamping subsystem uses (§5).

**Why it is worth copying.** Annotations, the text layer, search, thumbnails
and page navigation are all defined over PDF pages. A format that opens in a
viewer of its own gets none of them — which is why an image shown as an `<img>`
is an image nobody can mark up, however good the image renderer is. Converting
is not about display. It is about making one set of features apply to
everything.

**What this rebuild does.** `apps/web/src/lib/viewer/to-pdf.ts` converts raster
images to a PDF in the browser, and `openPdf` takes bytes instead of a URL when
it does; `pdf-document.ts` writes the file, which is a page list, a content
stream per page and an image per region — small enough that the geometry
annotations are stored against stays readable rather than sitting behind
someone else's defaults. A JPEG is embedded unchanged — JPEG *is* a PDF image
filter (`DCTDecode`), so a scan costs no quality and no re-encoding time;
everything else goes through a canvas. The colour space is read from the JPEG's
own frame header rather than assumed, because PDF requires it to have as many
components as the filter produces and a grayscale scan declared `DeviceRGB` is
a file no reader will open. Page size comes from the image's declared
resolution (JFIF density, PNG `pHYs`) and falls back to 96dpi, so a 300dpi scan
opens as a letter-sized page rather than a 26-inch one.

**TIFF, which turned out not to need a decoder.** TIFF is the format an ECM
cannot do without and a browser cannot read: it is what scanners and fax
servers write, it is the only common image format that holds many pages, and no
browser has ever decoded it. The obvious answer is a decoding dependency. The
better answer is that a TIFF is a *container*, and what it usually contains is
already a PDF image filter:

| TIFF compression | Becomes | Work done |
|---|---|---|
| CCITT Group 4 (4), Group 3 (3), RLE (2) | `/CCITTFaxDecode` | none — the bytes are copied |
| JPEG (7) | `/DCTDecode` | none — the bytes are copied |
| Deflate (8, 32946), LZW (5), PackBits (32773), none (1) | `/FlateDecode` | decoded and re-compressed, losslessly |
| old-style JPEG (6), tiled, BigTIFF | refused, with the reason | — |

`apps/web/src/lib/viewer/tiff.ts` reads the directory chain, and for a scan it
writes a dictionary and moves the strip across untouched. A 1728×1143 Group 4
fax page converts in **0ms** and the PDF is the TIFF's 7,050 bytes plus about
500 of structure. Decoding that page to pixels and re-encoding it as JPEG — the
obvious implementation — would have cost a megabyte, a generation of quality,
and the crisp edges that make scanned text readable at all.

Three details are worth naming because each one is a wrong-looking page if
missed. Strips cannot be concatenated: a Group 4 strip begins from an imaginary
white row above it, so two joined together decode to noise — each becomes its
own image object, stacked. `BlackIs1` follows `PhotometricInterpretation`, so a
fax renders as a fax and only a file that declares `BlackIsZero` comes out
inverted. And page size comes from each page's own resolution, which for fax is
204×196 and not square; a page laid out as though it were comes out a third too
tall.

Verified both ways [observed]: `tests/tiff.mjs` runs 196 assertions over 18
generated TIFFs — page boxes, filters, fax parameters, and for a pass-through
page that the stream in the PDF is byte for byte the stream in the TIFF, plus
every sample of a 2550×3300 colour page after the Deflate is undone. Separately
each fixture was rendered through PDF.js and the ink read back off the canvas,
which is what establishes that the hand-written fax parameters decode to the
right picture rather than merely to something. That suite needs no API and no
database, which is why `npm test` no longer requires one for it.

**JPEG 2000, which is three dozen lines because PDF already has the decoder.**
JPEG 2000 *is* a PDF image filter (`JPXDecode`), and PDF.js ships OpenJPEG as
WebAssembly to read it — which this app already serves, since `wasmUrl` is
needed for CCITT anyway. So `apps/web/src/lib/viewer/jpeg2000.ts` decodes
nothing at all: it reads the header for the page size and writes a dictionary
around the file.

Two decisions came out of reading the shipped PDF.js worker rather than
guessing. Its `parseImageProperties` scans for the SIZ marker *anywhere* in the
stream and `decode` hands the whole buffer to OpenJPEG, whose own format
detection takes a `.jp2` wrapper as readily as a bare codestream — so the file
goes in exactly as it arrived, which keeps the `colr` box, the only place an ICC
profile or a non-sRGB space is stated. Stripping to the bare codestream, which
is what the specification literally asks for, would discard that for nothing:
this PDF is built for display and discarded, and PDF.js is its only reader.
`/ColorSpace` and `/BitsPerComponent` are omitted, which for `JPXDecode` is
what the specification wants — the codestream states both, and a copy in the
dictionary could only contradict it.

**What is verified, and what is not.** There is no JPEG 2000 encoder on a
developer machine, and a wavelet codestream cannot be hand-written the way the
fax codes above can be. So `tests/jpeg2000.mjs` is 94 assertions over
hand-built *headers* with filler payloads: the size from the SIZ marker
including the reference-grid origin that makes `Xsiz` alone wrong, the page box
from the capture-resolution box, the byte-identical stream, and the absent
colour space. A non-square fixture is in there because vertical comes first
inside that box, the reverse of everywhere else.

Loading one of those through PDF.js then establishes the rest of the chain
[observed]: it found the SIZ marker, OpenJPEG initialised, and OpenJPEG parsed
the `.jp2` boxes and descended into the codestream before failing on the filler
with `Unknown marker ... Failed to read the header`. The page box came out
181.417 × 136.063pt, which is 640×480 at the 254dpi the fixture declared. Every
link is therefore checked except the wavelet decode itself — which belongs to
the same OpenJPEG build that reads every JPEG 2000 PDF in the wild. A real
`.jp2` has not been opened.

**Office** needs a real layout engine, which is why it is the server's
job. `GET /file/:id/pdf` converts through whatever `OFFICE_CONVERT_COMMAND`
names — LibreOffice headless is what it is written for — and caches the
result by content hash, as Dokmee cached its own in `App_Data` [observed:
`ViewerHelperUtil`]. With nothing configured the feature is absent rather
than broken: `session.me` reports the capability, and the viewer keeps the
renderers it has.

Verified against LibreOffice 26.8.2.2 [observed]: a two-page `.docx` came
back as two Letter pages with its text and its page break intact, an `.xlsx`
as one A4 page, an `.rtf` as one Letter page, each in 2.6–3.0s, and the
second request for the same bytes served the cache without starting the
converter.

### What conversion costs you

Two properties of rendering a document to PDF, neither of them this code's
doing and both of them true of Dokmee's viewer as well:

**A converted spreadsheet contains what was visible, not what was in the
cell.** `CONVERSION-MARKER-GAMMA` in a column narrow enough to clip it comes
back from the PDF as `CONVERS`. Whatever the column hides is not in the file
and cannot be searched or highlighted. For an ECM this is the sharp edge: a
long invoice number in a narrow column is not findable in the converted view,
though it is still in the stored spreadsheet. Full-text indexing should read
the original, never the rendition.

**A conversion is a second rendering of the document, not the document.**
Fonts that are not installed are substituted, and the layout can move. The
stored file is unchanged and remains what is downloaded; it is the *view* that
is derived. This is also why annotations on a converted document are kept
beside it rather than burned into it — and why the cache key is the content
hash, so the same bytes always produce the same geometry to store marks
against.
**One gap remains, and it is the interesting one: a converted image has no text
layer.** An image has no text, so search and the text markups do not apply to
it; ink, box and note do. This is now the *only* reason a document in this
viewer lacks a feature — every format reaches the same viewer, and a scan is
the one that arrives without words. Dokmee closes it with OCR
(`AddOCRService`), which this rebuild lists as an explicit stub. OCR with word
positions would make a scan searchable and highlightable, and that is the one
addition that would change what the viewer can do.

It is also where the TIFF work pays off a second time: a multi-page fax is now
a multi-page PDF with real page geometry, so OCR output has somewhere exact to
attach — a quad per word on a known page box — rather than needing a coordinate
system invented for it.

Burning stays PDF-only. The viewer builds the converted PDF in the browser; the
file on disk is still an image, so marks on it are kept beside it rather than
written into it, and both the worker and `annotation.queueBurn` say so.

---

## 9. Unknowns

- The 12 `disabledElements` entries behind string-table indices (§2).
- Whether `instance.Core.*` is used beyond `documentViewer` and
  `annotationManager`; a computed member access would not show in a string
  search (§3).
- Whether a WebViewer Server is deployed in practice, or `forceClientSideInit`
  is always taken — the endpoint exists, the deployment is not observable from
  the artifacts.
- The exact XFDF subset Dokmee emits and round-trips. Determining this needs a
  running instance and a saved annotation, which this analysis did not do.
- Which of the four WASM variants (`full`/`lean`, `optimized`, threaded) is
  actually served; `fullAPI: true` implies `full/` [inferred], but the
  threaded/optimized choice depends on runtime capability detection.

---

## 10. Method

Static analysis only. Nothing was launched, attached to, or instrumented, and
no installed file was modified. The REA MCP server provided the PE/CLI metadata
inspection (`Dms.Framework.dll` digest
`93dcb509e77ec141f856b0ff52f26ecff4e6a07ef638173f533e144c8faa56da`;
`Dokmee.Ecm.Web.dll` as recorded in
[REVERSE-ENGINEERING.md](REVERSE-ENGINEERING.md)); member decoding on
`Dms.Framework.dll` exceeded REA's 64 MiB representation budget and is recorded
as partial coverage rather than absence. The JavaScript integration was read
from Dokmee's own shipped bundle. Apryse's engine was not decompiled; the
behaviour in §8 was read from the API surface of `webviewer-core.min.js` and
from the original modules the shipped UI source maps carry in their
`sourcesContent` — the vendor's own text, read as reference and reimplemented,
not copied.
