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

## 8. Unknowns

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

## 9. Method

Static analysis only. Nothing was launched, attached to, or instrumented, and
no installed file was modified. The REA MCP server provided the PE/CLI metadata
inspection (`Dms.Framework.dll` digest
`93dcb509e77ec141f856b0ff52f26ecff4e6a07ef638173f533e144c8faa56da`;
`Dokmee.Ecm.Web.dll` as recorded in
[REVERSE-ENGINEERING.md](REVERSE-ENGINEERING.md)); member decoding on
`Dms.Framework.dll` exceeded REA's 64 MiB representation budget and is recorded
as partial coverage rather than absence. The JavaScript integration was read
from Dokmee's own shipped bundle. Apryse's engine was not decompiled and its
shipped source maps were not reconstructed.
