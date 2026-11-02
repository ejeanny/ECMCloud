// Burn: merge annotations into the page content, keep the pre-burn file as a
// version, and prove the marks are actually in the produced PDF rather than
// taking the job's green tick on trust.
import { readFileSync, writeFileSync } from 'node:fs';
import { PDFDocument, PDFName, PDFRawStream } from 'pdf-lib';
import { inflateSync } from 'node:zlib';
import { client, assert, finish } from './harness.mjs';

/** Each page's content streams, decompressed and concatenated. */
async function contentOf(bytes) {
  const pdf = await PDFDocument.load(bytes);
  return pdf.getPages().map((page) => {
    const contents = page.node.get(PDFName.of('Contents'));
    const refs = contents?.constructor?.name === 'PDFArray' ? contents.asArray() : [contents];
    let text = '';
    for (const ref of refs) {
      const stream = ref && page.node.context.lookup(ref);
      if (!(stream instanceof PDFRawStream)) continue;
      const raw = Buffer.from(stream.contents);
      const filter = stream.dict.get(PDFName.of('Filter'));
      text += (String(filter).includes('FlateDecode') ? inflateSync(raw) : raw).toString('latin1');
    }
    return text;
  });
}

/**
 * The operand string pdf-lib writes for a colour. It emits full float
 * precision, so the assertion has to compute the value rather than round it.
 */
function operands(hex) {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  return [m[1], m[2], m[3]].map((h) => String(Number.parseInt(h, 16) / 255)).join(' ');
}

/** Text drawn into a content stream, which PDF writes as hex strings. */
function drawnText(content) {
  return [...content.matchAll(/<([0-9A-Fa-f]+)>\s*Tj/g)]
    .map(([, hex]) => Buffer.from(hex, 'hex').toString('latin1'))
    .join('\n');
}

const admin = client();
await admin.m('session.login', { userName: 'admin', password: process.env.ECM_ADMIN_PASSWORD });
const cabinet = (await admin.q('cabinet.list', undefined))[0];

// --- a fresh document ---------------------------------------------------
const pdf = readFileSync(new URL('./fixtures/invoice.pdf', import.meta.url));
const stamp = new Date().toISOString().slice(11, 19).replace(/:/g, '');
const upload = await admin.m('upload.begin', {
  cabinetId: cabinet.id,
  parentId: null,
  fileName: `burn-test-${stamp}.pdf`,
  byteLength: pdf.byteLength,
  segmentCount: 1,
});
await admin.raw(`/upload/${upload.uploadId}/0`, {
  method: 'PUT',
  headers: { 'Content-Type': 'application/octet-stream' },
  body: pdf,
});
const doc = await admin.m('upload.finish', { uploadId: upload.uploadId, values: [] });
const nodeId = doc.nodeId;
assert('uploaded a PDF to burn into', !!nodeId, `${doc.byteLength} bytes`);

const before = Buffer.from(await (await admin.raw(`/file/${nodeId}`, {})).arrayBuffer());
const contentBefore = (await contentOf(before)).join("");
assert(
  'the original has no drawing operators of ours',
  !contentBefore.includes('0.17 0.83 0.54 rg'),
  `${contentBefore.length} bytes of content`,
);

// --- one of every kind --------------------------------------------------
const names = {
  highlight: crypto.randomUUID(),
  underline: crypto.randomUUID(),
  strikeout: crypto.randomUUID(),
  squiggly: crypto.randomUUID(),
  square: crypto.randomUUID(),
  circle: crypto.randomUUID(),
  ink: crypto.randomUUID(),
  line: crypto.randomUUID(),
  note: crypto.randomUUID(),
};

await admin.m('annotation.save', {
  nodeId,
  annotations: [
    { name: names.highlight, kind: 'highlight', page: 0, rect: { x1: 72, y1: 696, x2: 300, y2: 720 }, color: '#ffd400', opacity: 0.4, coords: [72, 720, 300, 720, 72, 696, 300, 696] },
    { name: names.underline, kind: 'underline', page: 0, rect: { x1: 72, y1: 658, x2: 330, y2: 672 }, color: '#2bd48a', opacity: 1, coords: [72, 672, 330, 672, 72, 658, 330, 658] },
    { name: names.strikeout, kind: 'strikeout', page: 0, rect: { x1: 72, y1: 640, x2: 290, y2: 654 }, color: '#ff6b6b', opacity: 1, coords: [72, 654, 290, 654, 72, 640, 290, 640] },
    { name: names.squiggly, kind: 'squiggly', page: 0, rect: { x1: 72, y1: 614, x2: 300, y2: 628 }, color: '#c084fc', opacity: 1, coords: [72, 628, 300, 628, 72, 614, 300, 614] },
    { name: names.square, kind: 'square', page: 1, rect: { x1: 80, y1: 420, x2: 300, y2: 500 }, color: '#4aa3ff', opacity: 1, width: 2 },
    { name: names.circle, kind: 'circle', page: 1, rect: { x1: 330, y1: 420, x2: 470, y2: 500 }, color: '#ff6b6b', opacity: 1, width: 1.5 },
    { name: names.ink, kind: 'ink', page: 1, rect: { x1: 100, y1: 250, x2: 260, y2: 330 }, color: '#111111', opacity: 1, width: 2, gestures: [[100, 250, 150, 320, 200, 260, 260, 330]] },
    { name: names.line, kind: 'line', page: 2, rect: { x1: 90, y1: 400, x2: 400, y2: 460 }, color: '#2bd48a', opacity: 1, width: 2 },
    // Deliberately includes a character the standard fonts cannot encode.
    { name: names.note, kind: 'text', page: 2, rect: { x1: 90, y1: 600, x2: 114, y2: 624 }, color: '#ffd400', opacity: 1, contents: 'Needs a signature before 30 Nov — ask 田中 in finance' },
  ],
});
assert('nine annotations saved', (await admin.q('annotation.list', { nodeId })).length === 9);

// --- burn ----------------------------------------------------------------
const job = await admin.m('annotation.queueBurn', { nodeId });
assert('burn queued', job.annotations === 9, `${job.annotations} pending`);

let state = null;
for (let i = 0; i < 20; i++) {
  await new Promise((r) => setTimeout(r, 750));
  const list = await admin.q('annotation.list', { nodeId });
  if (list.every((a) => a.burnedAt)) {
    state = list;
    break;
  }
}
assert('all nine are marked burned', state?.length === 9, state ? 'burnedAt set on every row' : 'timed out');

const failed = await admin.q('job.failed', { take: 50 });
assert('the burn job did not fail', !failed.some((j) => j.id === job.jobId),
  failed.find((j) => j.id === job.jobId)?.lastError ?? 'no failure recorded');

// --- the produced file ---------------------------------------------------
const after = Buffer.from(await (await admin.raw(`/file/${nodeId}`, {})).arrayBuffer());
assert('the stored file changed', !after.equals(before), `${before.byteLength} -> ${after.byteLength} bytes`);
// Written out so a human can open the result; generated, so not committed.
writeFileSync(new URL('./fixtures/burned.pdf', import.meta.url), after);

const pages = await contentOf(after);
assert('the produced file still has three pages of content', pages.length === 3);

// Each mark must be on the page it was drawn on — not merely somewhere in the
// file — so the page index is part of every assertion.
const onPage = {
  'page 1: highlight fill': [0, `${operands('#ffd400')} rg`],
  'page 1: underline stroke': [0, `${operands('#2bd48a')} RG`],
  'page 1: strikeout stroke': [0, `${operands('#ff6b6b')} RG`],
  'page 1: squiggly stroke': [0, `${operands('#c084fc')} RG`],
  'page 2: square border': [1, `${operands('#4aa3ff')} RG`],
  'page 2: circle border': [1, `${operands('#ff6b6b')} RG`],
  'page 2: ink stroke': [1, `${operands('#111111')} RG`],
  'page 3: line stroke': [2, `${operands('#2bd48a')} RG`],
  'page 3: note marker fill': [2, `${operands('#ffd400')} rg`],
};
for (const [label, [page, needle]] of Object.entries(onPage)) {
  assert(`burned ${label}`, pages[page].includes(needle), needle.slice(0, 40));
}

// Nothing may land on a page it was not drawn on.
assert(
  'page 3 carries no highlight stroke from page 1',
  !pages[2].includes(`${operands('#c084fc')} RG`),
);

// Geometry: the highlight quad was x 72..300, y 696..720, i.e. 228 x 24 at
// (72, 696). pdf-lib translates with `cm` and then draws the path at the origin.
assert(
  'the highlight is at the stored coordinates',
  /1 0 0 1 72 696 cm/.test(pages[0]) && /228 24 l/.test(pages[0]),
  '228x24 at (72,696)',
);
assert(
  'the underline sits on the quad baseline',
  /72 659 m[\s\S]{0,20}330 659 l/.test(pages[0]),
  'y = 658 + 1',
);

// Blend and opacity ride on an ExtGState, which is what keeps a highlight from
// painting over the glyphs it marks.
assert('an ExtGState is set for the marks', /\/GS[-\d]+ gs/.test(pages[0]));

// Path construction and painting operators (pdf-lib writes explicit paths, not `re`).
assert('paths are constructed and painted', /\bh\b/.test(pages[0]) && /\bf\b/.test(pages[0]));
assert('strokes are emitted', /\bS\b/.test(pages[0]));

// The note's unencodable characters must become '?' rather than crash the job.
const noteText = drawnText(pages[2]);
assert(
  'the note text is drawn into the page',
  noteText.includes('Needs a signature before 30 Nov'),
  JSON.stringify(noteText.slice(0, 60)),
);
assert(
  'characters the standard fonts cannot encode became question marks',
  noteText.includes('??') && !noteText.includes('田'),
  'CJK replaced, job survived',
);
assert('the note wrapped onto a second line', noteText.includes('finance'));

// It must still be a readable PDF with the same page count.
const reloaded = await PDFDocument.load(after);
assert('the produced file is a valid PDF', reloaded.getPageCount() === 3, `${reloaded.getPageCount()} pages`);

// --- the original is kept as a version ----------------------------------
const versions = await admin.q('version.list', { nodeId });
assert('a version was created', versions.length === 1, versions.map((v) => v.label).join(', '));
assert('the version says why', /Before burning 9/.test(versions[0]?.comment ?? ''), versions[0]?.comment);
assert('the version is attributed', versions[0]?.createdBy === 'admin', String(versions[0]?.createdBy));

const original = Buffer.from(
  await (await admin.raw(`/file/${nodeId}/download?version=${versions[0].id}`, {})).arrayBuffer(),
);
assert('the pre-burn bytes are recoverable', original.equals(before), `${original.byteLength} bytes`);

// --- burned annotations are frozen --------------------------------------
try {
  await admin.m('annotation.save', {
    nodeId,
    annotations: [
      { name: names.square, kind: 'square', page: 1, rect: { x1: 1, y1: 1, x2: 9, y2: 9 }, color: '#ffd400', opacity: 1 },
    ],
  });
  failures += 1;
  console.log('FAIL  a burned annotation cannot be edited — accepted');
} catch (err) {
  assert('a burned annotation cannot be edited', err.code === 'CONFLICT', err.message);
}

const kept = await admin.m('annotation.remove', { nodeId, names: [names.square] });
assert('a burned annotation is not deleted', kept.removed === 0 && kept.kept === 1, JSON.stringify(kept));

try {
  await admin.m('annotation.queueBurn', { nodeId });
  failures += 1;
  console.log('FAIL  burning twice — accepted');
} catch (err) {
  assert('burning again is refused once everything is burned', err.code === 'CONFLICT', err.message);
}

// --- and the burn is undoable -------------------------------------------
await admin.m('version.revert', { nodeId, versionId: versions[0].id });
const reverted = Buffer.from(await (await admin.raw(`/file/${nodeId}`, {})).arrayBuffer());
assert('reverting restores the un-annotated original', reverted.equals(before), `${reverted.byteLength} bytes`);

finish();
