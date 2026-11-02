/**
 * Which formats are shown by converting them to PDF first.
 *
 * Shared because both ends need the same answer and must not disagree: the web
 * app decides whether to open a document in the PDF viewer, and the API
 * decides whether it is willing to convert it. A list that drifts apart shows
 * up as a viewer that opens an empty pane.
 *
 * Apryse does the same thing behind `loadAsPDF` (PDF-VIEWER.md §8.4) — Word,
 * Excel, PowerPoint and email all reach its viewer as PDF, which is why one
 * viewer has annotations, search and thumbnails for every one of them.
 */

/**
 * Office documents, converted by the server because they need a layout engine.
 *
 * Deliberately not "everything LibreOffice accepts", which is a far longer
 * list including formats nobody stores in an ECM. These are the ones worth
 * claiming: if the converter is handed something outside this set it is a bug
 * in the caller, not a fallback to be discovered at run time.
 */
export const OFFICE_TO_PDF_EXT = [
  // Word
  'doc',
  'docx',
  'docm',
  'dot',
  'dotx',
  'odt',
  'rtf',
  // Excel
  'xls',
  'xlsx',
  'xlsm',
  'xlt',
  'xltx',
  'ods',
  // Not CSV: it is a spreadsheet format only by convention, and the app's own
  // table renderer reads it better than a converter's idea of where the page
  // breaks go.
  // PowerPoint
  'ppt',
  'pptx',
  'pps',
  'ppsx',
  'pot',
  'potx',
  'odp',
  // Drawing and text
  'odg',
  'vsd',
  'vsdx',
] as const;

const OFFICE = new Set<string>(OFFICE_TO_PDF_EXT);

/** Does this format need the server's converter to become a PDF? */
export function needsServerPdf(ext: string | null | undefined): boolean {
  return OFFICE.has((ext ?? '').toLowerCase());
}
