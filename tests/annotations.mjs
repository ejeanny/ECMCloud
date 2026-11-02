// End-to-end exercise of the annotation surface: upload a real PDF, mark it
// up, round-trip the markup through XFDF, and prove the four annotation
// privileges are actually separate. Runs against the dev API on 127.0.0.1:4000.
import { readFileSync } from 'node:fs';
import { client, assert, refused, rejected, finish } from './harness.mjs';

/** The save call under test always has the same shape, so pass just the body. */
const saveRejected = (label, input, expect) =>
  rejected(label, () => admin.m('annotation.save', input), expect);

const admin = client();
await admin.m('session.login', {
  userName: 'admin',
  password: process.env.ECM_ADMIN_PASSWORD,
});

const cabinets = await admin.q('cabinet.list', undefined);
const cabinet = cabinets[0];
assert('cabinet', !!cabinet, cabinet.name);

// --- upload the PDF ----------------------------------------------------
const pdf = readFileSync(new URL('./fixtures/invoice.pdf', import.meta.url));
const stamp = new Date().toISOString().slice(11, 19).replace(/:/g, '');

const upload = await admin.m('upload.begin', {
  cabinetId: cabinet.id,
  parentId: null,
  fileName: `viewer-test-${stamp}.pdf`,
  byteLength: pdf.byteLength,
  segmentCount: 1,
});
const put = await admin.raw(`/upload/${upload.uploadId}/0`, {
  method: 'PUT',
  headers: { 'Content-Type': 'application/octet-stream' },
  body: pdf,
});
assert('upload segment', put.status === 204, `HTTP ${put.status}`);

const doc = await admin.m('upload.finish', { uploadId: upload.uploadId, values: [] });
assert('upload.finish', !!doc.nodeId, `${doc.byteLength} bytes`);
const nodeId = doc.nodeId;

// The bytes must come back byte-identical, or PDF.js has nothing valid to parse.
const fetched = await admin.raw(`/file/${nodeId}`, {});
const back = Buffer.from(await fetched.arrayBuffer());
assert('download is byte-identical', back.equals(pdf), `${back.byteLength} bytes`);
assert('served as PDF', fetched.headers.get('content-type') === 'application/pdf');

// --- create annotations -------------------------------------------------
const highlightName = crypto.randomUUID();
const inkName = crypto.randomUUID();
const noteName = crypto.randomUUID();

const saved = await admin.m('annotation.save', {
  nodeId,
  annotations: [
    {
      name: highlightName,
      kind: 'highlight',
      page: 0,
      rect: { x1: 72, y1: 696, x2: 260, y2: 720 },
      color: '#ffd400',
      opacity: 0.4,
      // UL, UR, LL, LR — the quad over "Invoice 2026-114".
      coords: [72, 720, 260, 720, 72, 696, 260, 696],
      contents: 'Check this number against the PO',
    },
    {
      name: inkName,
      kind: 'ink',
      page: 1,
      rect: { x1: 100, y1: 300, x2: 240, y2: 360 },
      color: '#ff6b6b',
      opacity: 1,
      width: 2,
      gestures: [[100, 300, 140, 340, 190, 310, 240, 360]],
    },
    {
      name: noteName,
      kind: 'text',
      page: 2,
      rect: { x1: 400, y1: 600, x2: 424, y2: 624 },
      color: '#4aa3ff',
      opacity: 1,
      contents: 'Third page needs a signature',
    },
  ],
});
assert('annotation.save creates three', saved.length === 3);

const listed = await admin.q('annotation.list', { nodeId });
assert('annotation.list returns three', listed.length === 3);
assert(
  'list is in page order',
  listed.map((a) => a.page).join(',') === '0,1,2',
  listed.map((a) => `${a.kind}@p${a.page + 1}`).join(' '),
);
assert('author resolved', listed[0].author === 'admin', String(listed[0].author));
assert('canEdit for the author', listed.every((a) => a.canEdit === true));

const hl = listed.find((a) => a.name === highlightName);
assert('coords survive the round trip', JSON.stringify(hl.coords) === JSON.stringify([72, 720, 260, 720, 72, 696, 260, 696]));
const ink = listed.find((a) => a.name === inkName);
assert('ink gestures survive', JSON.stringify(ink.gestures) === JSON.stringify([[100, 300, 140, 340, 190, 310, 240, 360]]));

// --- edit ---------------------------------------------------------------
await admin.m('annotation.save', {
  nodeId,
  annotations: [
    {
      name: highlightName,
      kind: 'highlight',
      page: 0,
      rect: { x1: 72, y1: 696, x2: 300, y2: 720 },
      color: '#2bd48a',
      opacity: 0.5,
      coords: [72, 720, 300, 720, 72, 696, 300, 696],
      contents: 'Checked — matches PO 88213',
    },
  ],
});
const afterEdit = await admin.q('annotation.list', { nodeId });
assert('editing updates in place, not duplicates', afterEdit.length === 3);
const edited = afterEdit.find((a) => a.name === highlightName);
assert('edit applied', edited.color === '#2bd48a' && edited.rect.x2 === 300, `${edited.color} x2=${edited.rect.x2}`);

// --- XFDF ---------------------------------------------------------------
const exported = await admin.q('annotation.exportXfdf', { nodeId });
const xml = exported.xml;
assert('xfdf declares the namespace', xml.includes('xmlns="http://ns.adobe.com/xfdf/"'));
assert('xfdf has the highlight with coords', /<highlight [^>]*coords="72,720,300,720,72,696,300,696"/.test(xml));
assert('xfdf has the ink gesture', /<gesture>100,300;140,340;190,310;240,360<\/gesture>/.test(xml));
assert('xfdf carries contents', xml.includes('<contents>Checked — matches PO 88213</contents>'));
assert('xfdf dates are PDF syntax', /creationdate="D:\d{14}Z"/.test(xml));
assert('xfdf names the author', /title="admin"/.test(xml));
assert('sticky note gets an icon', /<text [^>]*icon="Comment"/.test(xml));

// Round-trip into a second document and compare geometry.
const upload2 = await admin.m('upload.begin', {
  cabinetId: cabinet.id,
  parentId: null,
  fileName: `viewer-roundtrip-${stamp}.pdf`,
  byteLength: pdf.byteLength,
  segmentCount: 1,
});
await admin.raw(`/upload/${upload2.uploadId}/0`, {
  method: 'PUT',
  headers: { 'Content-Type': 'application/octet-stream' },
  body: pdf,
});
const doc2 = await admin.m('upload.finish', { uploadId: upload2.uploadId, values: [] });

const imported = await admin.m('annotation.importXfdf', { nodeId: doc2.nodeId, xml });
assert('importXfdf reads all three back', imported.imported === 3, `${imported.imported}`);

const rt = await admin.q('annotation.list', { nodeId: doc2.nodeId });
const rtHl = rt.find((a) => a.kind === 'highlight');
const rtInk = rt.find((a) => a.kind === 'ink');
assert('round-tripped highlight keeps its rect', rtHl.rect.x1 === 72 && rtHl.rect.x2 === 300, JSON.stringify(rtHl.rect));
assert('round-tripped highlight keeps its colour', rtHl.color === '#2bd48a', rtHl.color);
assert('round-tripped highlight keeps its coords', JSON.stringify(rtHl.coords) === JSON.stringify([72, 720, 300, 720, 72, 696, 300, 696]));
assert('round-tripped ink keeps its gesture', JSON.stringify(rtInk.gestures) === JSON.stringify([[100, 300, 140, 340, 190, 310, 240, 360]]));
assert('round-tripped note keeps its text', rt.find((a) => a.kind === 'text')?.contents === 'Third page needs a signature');

// --- validation ---------------------------------------------------------
await saveRejected(
  'a highlight without quadpoints is refused',
  {
    nodeId,
    annotations: [
      { name: crypto.randomUUID(), kind: 'highlight', page: 0, rect: { x1: 1, y1: 1, x2: 2, y2: 2 }, color: '#ffd400', opacity: 1 },
    ],
  },
  'quadpoints',
);

await saveRejected(
  'ink without a gesture is refused',
  {
    nodeId,
    annotations: [
      { name: crypto.randomUUID(), kind: 'ink', page: 0, rect: { x1: 1, y1: 1, x2: 2, y2: 2 }, color: '#ffd400', opacity: 1 },
    ],
  },
  'gesture',
);

const dup = crypto.randomUUID();
await saveRejected(
  'two annotations sharing a name in one request are refused',
  {
    nodeId,
    annotations: [
      { name: dup, kind: 'square', page: 0, rect: { x1: 1, y1: 1, x2: 20, y2: 20 }, color: '#ffd400', opacity: 1 },
      { name: dup, kind: 'square', page: 0, rect: { x1: 1, y1: 1, x2: 20, y2: 20 }, color: '#ffd400', opacity: 1 },
    ],
  },
  'share a name',
);

// --- the four privileges are genuinely separate --------------------------
const roles = await admin.q('security.roles', undefined);
const usersRole = roles.find((r) => r.name === 'Users_Role' || r.name === 'Users');
const exportRole = roles.find((r) => r.name === 'Data_Export_Role' || r.name === 'Data Export');
assert('built-in roles present', !!usersRole && !!exportRole, roles.map((r) => r.name).join(', '));

const PASSWORD = 'Annotation-Test-Pass-1!';
async function userWith(role, name) {
  await admin.m('security.createUser', {
    userName: name,
    password: PASSWORD,
    isTempPassword: false,
    roleIds: [role.id],
  });
  const c = client();
  await c.m('session.login', { userName: name, password: PASSWORD });
  return c;
}

const marker = await userWith(usersRole, `annot-user-${stamp}`);
const viewer = await userWith(exportRole, `annot-view-${stamp}`);

// Users_Role may add and edit, but not delete or burn.
const markerName = crypto.randomUUID();
const byMarker = await marker.m('annotation.save', {
  nodeId,
  annotations: [
    { name: markerName, kind: 'square', page: 0, rect: { x1: 300, y1: 200, x2: 420, y2: 280 }, color: '#c084fc', opacity: 1, width: 2 },
  ],
});
assert('Users_Role can add an annotation', byMarker.length === 1);

await refused(
  'Users_Role cannot delete an annotation',
  () => marker.m('annotation.remove', { nodeId, names: [markerName] }),
  'Delete_Annotation',
);
await refused(
  'Users_Role cannot burn',
  () => marker.m('annotation.queueBurn', { nodeId }),
  'Burn_Annotation',
);

// Data_Export_Role may look but not mark up.
const seen = await viewer.q('annotation.list', { nodeId });
assert('Data_Export_Role can read annotations', seen.length === 4, `${seen.length}`);
assert('a non-author cannot edit', seen.every((a) => a.canEdit === false));
await refused(
  'Data_Export_Role cannot add an annotation',
  () =>
    viewer.m('annotation.save', {
      nodeId,
      annotations: [
        { name: crypto.randomUUID(), kind: 'square', page: 0, rect: { x1: 1, y1: 1, x2: 20, y2: 20 }, color: '#ffd400', opacity: 1 },
      ],
    }),
  'Add_Annotation',
);

// An author who is not an administrator cannot overwrite someone else's.
try {
  await marker.m('annotation.save', {
    nodeId,
    annotations: [
      { name: highlightName, kind: 'highlight', page: 0, rect: { x1: 1, y1: 1, x2: 2, y2: 2 }, color: '#ffd400', opacity: 1, coords: [1, 2, 2, 2, 1, 1, 2, 1] },
    ],
  });
  failures += 1;
  console.log("FAIL  a non-author cannot edit another user's annotation — accepted");
} catch (err) {
  assert(
    "a non-author cannot edit another user's annotation",
    err.code === 'CONFLICT',
    `${err.code}: ${err.message}`,
  );
}

// --- delete and burn ----------------------------------------------------
const removed = await admin.m('annotation.remove', { nodeId, names: [markerName] });
assert('an administrator can delete any annotation', removed.removed === 1 && removed.kept === 0, JSON.stringify(removed));

const burnJob = await admin.m('annotation.queueBurn', { nodeId });
assert('burn is queued', !!burnJob.jobId, `job ${burnJob.jobId.slice(0, 8)}, ${burnJob.annotations} annotations`);

// The burn runs for real; burn.mjs checks what it draws. Here it only has to
// finish without failing and stamp the rows.
let settled = null;
for (let i = 0; i < 20; i++) {
  await new Promise((r) => setTimeout(r, 750));
  const rows = await admin.q('annotation.list', { nodeId });
  if (rows.every((a) => a.burnedAt)) {
    settled = rows;
    break;
  }
}
assert('the burn completes and stamps every row', settled !== null, `${settled?.length ?? 0} burned`);
const jobs = await admin.q('job.failed', { take: 50 });
assert(
  'the burn job did not fail',
  !jobs.some((j) => j.id === burnJob.jobId),
  jobs.find((j) => j.id === burnJob.jobId)?.lastError ?? 'no failure recorded',
);

// A document with nothing to burn must say so rather than queue a no-op job.
const cleared = await admin.m('annotation.remove', {
  nodeId: doc2.nodeId,
  names: rt.map((a) => a.name),
});
assert('clearing the round-trip document', cleared.removed === 3, JSON.stringify(cleared));
try {
  await admin.m('annotation.queueBurn', { nodeId: doc2.nodeId });
  failures += 1;
  console.log('FAIL  burning a document with no annotations — accepted');
} catch (err) {
  assert(
    'burning a document with no annotations is refused',
    err.code === 'CONFLICT',
    err.message,
  );
}

finish();
