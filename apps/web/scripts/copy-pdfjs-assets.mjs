/**
 * Stage PDF.js's runtime assets into `public/`.
 *
 * Four of them cannot be bundled, because PDF.js fetches them by URL at run
 * time rather than importing them:
 *
 *   pdf.worker.min.mjs  the parser/rasteriser, which runs in a web worker
 *   cmaps/              CJK character maps — without them CJK text is blank
 *   standard_fonts/     the 14 standard fonts, for PDFs that embed no font
 *   wasm/               JPX (JPEG 2000) and other codecs — i.e. scanned pages
 *   iccs/               ICC profiles, so tagged colour is not approximated
 *
 * An ECM is exactly the application that meets all of these: scanned invoices
 * carry JPEG 2000, and documents arrive from everywhere. Copying rather than
 * vendoring keeps the served bytes identical to the installed version.
 */
import { cp, mkdir, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const pkg = path.dirname(require.resolve('pdfjs-dist/package.json'));
const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const publicDir = path.join(here, '..', 'public');
const assets = path.join(publicDir, 'pdfjs');

await mkdir(publicDir, { recursive: true });
await rm(assets, { recursive: true, force: true });
await mkdir(assets, { recursive: true });

await cp(
  path.join(pkg, 'build', 'pdf.worker.min.mjs'),
  path.join(publicDir, 'pdf.worker.min.mjs'),
);

for (const dir of ['cmaps', 'standard_fonts', 'wasm', 'iccs']) {
  await cp(path.join(pkg, dir), path.join(assets, dir), { recursive: true });
}

console.log(`pdf.js assets staged in ${path.relative(process.cwd(), publicDir)}`);
