/**
 * What the viewer will do with a document, decided from its extension.
 *
 * Dokmee answered this question by converting everything to PDF first
 * (`loadAsPDF`), and this rebuild now answers it the same way for every format
 * that can be marked up.
 *
 * A raster image takes that route in the browser: `to-pdf.ts` makes it a PDF
 * and it opens in the PDF viewer with everything that viewer has. TIFF goes
 * with it, as many pages as the file holds (`tiff.ts`). An office document
 * takes the longer road through the server's converter, when one is configured.
 *
 * Images are still listed as `image` below, because that is what the file *is*
 * — `convertsToPdf` decides where it opens, and the download, the icon and the
 * name all still want to know it is an image.
 *
 * Everything else is met where it is: the browser can play media and lay out
 * text, and DOCX has a library that runs client-side as a fallback for a
 * deployment with no converter.
 */
export type ViewerFormat =
  | 'pdf'
  | 'image'
  | 'text'
  | 'markdown'
  | 'csv'
  | 'html'
  | 'audio'
  | 'video'
  | 'docx'
  | 'unsupported';

const BY_EXT: Record<string, ViewerFormat> = {
  pdf: 'pdf',

  // Anything the browser decodes itself.
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  gif: 'image',
  webp: 'image',
  bmp: 'image',
  avif: 'image',
  ico: 'image',
  svg: 'image',

  // And the one it does not: a TIFF is read and converted by `tiff.ts`, so it
  // never reaches the plain image renderer. It is an image all the same.
  tif: 'image',
  tiff: 'image',

  md: 'markdown',
  markdown: 'markdown',

  csv: 'csv',
  tsv: 'csv',

  // Rendered in a sandboxed frame — see the renderer for why it is never
  // served as text/html from this origin.
  html: 'html',
  htm: 'html',

  mp3: 'audio',
  wav: 'audio',
  ogg: 'audio',
  oga: 'audio',
  m4a: 'audio',
  flac: 'audio',
  aac: 'audio',

  mp4: 'video',
  webm: 'video',
  ogv: 'video',
  mov: 'video',
  m4v: 'video',

  docx: 'docx',
};

/** Extensions shown as text: prose, data and source alike. */
const TEXT_EXT = new Set([
  'txt', 'log', 'text', 'rtf', 'eml',
  'json', 'jsonl', 'ndjson', 'xml', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'env',
  'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'css', 'scss', 'less',
  'py', 'rb', 'go', 'rs', 'java', 'kt', 'cs', 'c', 'h', 'cpp', 'hpp', 'php', 'swift',
  'sh', 'bash', 'zsh', 'ps1', 'bat', 'sql', 'graphql', 'gql', 'diff', 'patch',
  'dockerfile', 'makefile', 'gitignore', 'properties',
]);

/** Extensions whose text is source, so it wants a monospace gutter. */
const CODE_EXT = new Set([
  'json', 'jsonl', 'ndjson', 'xml', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'env',
  'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'css', 'scss', 'less',
  'py', 'rb', 'go', 'rs', 'java', 'kt', 'cs', 'c', 'h', 'cpp', 'hpp', 'php', 'swift',
  'sh', 'bash', 'zsh', 'ps1', 'bat', 'sql', 'graphql', 'gql', 'diff', 'patch',
  'dockerfile', 'makefile', 'properties',
]);

export function formatFor(ext: string | null | undefined): ViewerFormat {
  const key = (ext ?? '').toLowerCase();
  if (!key) return 'unsupported';
  return BY_EXT[key] ?? (TEXT_EXT.has(key) ? 'text' : 'unsupported');
}

export function isCode(ext: string | null | undefined): boolean {
  return CODE_EXT.has((ext ?? '').toLowerCase());
}

/** Every document now opens in the viewer; only a folder does not. */
export function viewerHrefFor(node: { id: string }): string {
  return `/v/${node.id}`;
}

/**
 * Formats with no in-browser renderer, named so the fallback can say what the
 * file is rather than only that it cannot show it.
 *
 * The office formats here are only unreachable on a deployment with no
 * document converter configured: with one, they open in the PDF viewer like
 * everything else, and this table is never consulted for them. There is no
 * client-side fallback for them on purpose — the spreadsheet and presentation
 * parsers that run in a browser are either unmaintained on npm or carry open
 * advisories, and parsing an uploaded file with one of those is a poor trade
 * for a preview.
 */
export const FORMAT_NOTES: Record<string, string> = {
  xlsx: 'Spreadsheet',
  xls: 'Spreadsheet',
  xlsm: 'Spreadsheet',
  ppt: 'Presentation',
  pptx: 'Presentation',
  doc: 'Word document (legacy format)',
  msg: 'Outlook message',
  zip: 'Archive',
  rar: 'Archive',
  '7z': 'Archive',
};
