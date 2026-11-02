/**
 * Write a small, genuinely valid multi-page PDF to test the viewer with:
 * real text (so the text layer and highlight-from-selection work), real page
 * boundaries, and a correct xref table built from measured byte offsets rather
 * than guessed at.
 */
import { writeFileSync } from 'node:fs';

const PAGES = 3;

function contentFor(page) {
  const lines = [
    `BT /F1 24 Tf 72 700 Td (Invoice 2026-${114 + page}) Tj ET`,
    `BT /F1 12 Tf 72 664 Td (Acme Corporation, 14 Bridge Street, Rotterdam) Tj ET`,
    `BT /F1 12 Tf 72 646 Td (Amount due 1250.00 EUR, net 30 days) Tj ET`,
    `BT /F1 12 Tf 72 620 Td (This paragraph exists so that text selection has) Tj ET`,
    `BT /F1 12 Tf 72 604 Td (something to select, and so that a search for the) Tj ET`,
    `BT /F1 12 Tf 72 588 Td (word Rotterdam finds a hit on every page.) Tj ET`,
    `BT /F1 10 Tf 72 100 Td (Page ${page + 1} of ${PAGES}) Tj ET`,
    // A visible rule, so a rendered page is obviously not a blank canvas.
    `0.6 w 72 740 m 540 740 l S`,
  ];
  return lines.join('\n');
}

const objects = [];
function add(body) {
  objects.push(body);
  return objects.length; // 1-based object number
}

// Reserve 1 (catalog) and 2 (pages) so the kids can reference them.
objects.push(null, null);

const fontNo = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');

const pageNos = [];
for (let p = 0; p < PAGES; p++) {
  const content = contentFor(p);
  const streamNo = add(
    `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`,
  );
  pageNos.push(
    add(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ` +
        `/Resources << /Font << /F1 ${fontNo} 0 R >> >> /Contents ${streamNo} 0 R >>`,
    ),
  );
}

objects[0] = '<< /Type /Catalog /Pages 2 0 R >>';
objects[1] = `<< /Type /Pages /Kids [${pageNos.map((n) => `${n} 0 R`).join(' ')}] /Count ${PAGES} >>`;

// Emit, recording the byte offset of every object for the xref table.
let pdf = '%PDF-1.7\n%\xE2\xE3\xCF\xD3\n';
const offsets = [];
objects.forEach((body, i) => {
  offsets[i] = Buffer.byteLength(pdf, 'latin1');
  pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
});

const xrefAt = Buffer.byteLength(pdf, 'latin1');
pdf += `xref\n0 ${objects.length + 1}\n`;
pdf += '0000000000 65535 f \n';
for (const offset of offsets) {
  pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
}
pdf +=
  `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n` +
  `startxref\n${xrefAt}\n%%EOF\n`;

const out = process.argv[2] ?? 'invoice.pdf';
writeFileSync(out, Buffer.from(pdf, 'latin1'));
console.log(`${out}: ${Buffer.byteLength(pdf, 'latin1')} bytes, ${PAGES} pages`);
