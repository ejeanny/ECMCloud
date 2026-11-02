/**
 * What the viewer will do with a document, decided from its extension.
 *
 * Dokmee answered this question by converting everything to PDF first
 * (`loadAsPDF`), which needed the conversion engine this rebuild does not
 * ship. The alternative is to meet each format where it is: the browser can
 * already draw images, play media and lay out text, and PDF and DOCX have
 * libraries that run client-side. Nothing here asks the server to convert
 * anything, so nothing here needs an engine.
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
 * file is rather than only that it cannot show it. Office formats other than
 * .docx are the honest gap: the spreadsheet and presentation parsers that run
 * client-side are either unmaintained on npm or carry open advisories, and
 * parsing an uploaded file with one of those is a poor trade for a preview.
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
  tif: 'TIFF image',
  tiff: 'TIFF image',
};
