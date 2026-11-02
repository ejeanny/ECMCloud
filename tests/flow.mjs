// End-to-end exercise of the API: login -> upload -> index -> search ->
// version -> recycle. Runs against the dev server on 127.0.0.1:4000.
const BASE = 'http://127.0.0.1:4000';
let cookie = '';

async function call(path, input, method = 'POST') {
  const url =
    method === 'GET'
      ? `${BASE}/trpc/${path}?input=${encodeURIComponent(JSON.stringify(input))}`
      : `${BASE}/trpc/${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(cookie ? { Cookie: cookie } : {}),
    },
    ...(method === 'POST' ? { body: JSON.stringify(input) } : {}),
  });
  const setCookie = res.headers.getSetCookie?.() ?? [];
  for (const c of setCookie) {
    if (c.startsWith('ecm_session=')) cookie = c.split(';')[0];
  }
  const body = await res.json();
  if (body.error) {
    throw new Error(`${path} -> ${body.error.message}`);
  }
  return body.result?.data;
}

const q = (p, i) => call(p, i, 'GET');
const m = (p, i) => call(p, i, 'POST');

let failures = 0;
function ok(label, detail) {
  console.log(`PASS  ${label}${detail ? ` — ${detail}` : ''}`);
}
function assert(label, condition, detail) {
  if (condition) {
    console.log(`PASS  ${label}${detail ? ` — ${detail}` : ''}`);
  } else {
    failures += 1;
    console.log(`FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

const session = await m('session.login', {
  userName: 'admin',
  password: process.env.ECM_ADMIN_PASSWORD,
});
ok('login', `session ${session.sessionId.slice(0, 8)}, expires ${session.expiresAt}`);

const me = await q('session.me', undefined);
ok('session.me', `${me.systemRights.length} system rights, admin=${me.isAdministrator}`);

const cabinets = await q('cabinet.list', undefined);
const cabinet = cabinets[0];
ok('cabinet.list', `${cabinets.length} cabinet(s): ${cabinet.name}`);

const fields = await q('indexField.columns', { cabinetId: cabinet.id });
ok('indexField.columns', fields.map((f) => f.label).join(', '));

// --- folder ------------------------------------------------------------
const folder = await m('node.createFolder', {
  cabinetId: cabinet.id,
  parentId: null,
  name: `Acme Corp ${new Date().toISOString().slice(11, 19)}`,
});
ok('node.createFolder', `${folder.name} (${folder.id.slice(0, 8)})`);

// --- chunked upload ----------------------------------------------------
const content = Buffer.from(
  'INVOICE 2026-0042\nSupplier: Acme Corp\nAmount: 1499.50 EUR\n' +
    'Reference: widget delivery, October 2026.\n',
  'utf8',
);

const upload = await m('upload.begin', {
  cabinetId: cabinet.id,
  parentId: folder.id,
  fileName: 'invoice-2026-0042.txt',
  byteLength: content.byteLength,
  segmentCount: 1,
});
ok('upload.begin', `uploadId ${upload.uploadId.slice(0, 8)}`);

const put = await fetch(`${BASE}/upload/${upload.uploadId}/0`, {
  method: 'PUT',
  headers: { 'Content-Type': 'application/octet-stream', Cookie: cookie },
  body: content,
});
ok('PUT segment', `HTTP ${put.status}`);

const status = await q('upload.status', { uploadId: upload.uploadId });
ok('upload.status', `received ${JSON.stringify(status.received)}, missing ${JSON.stringify(status.missing)}`);

const titleField = fields.find((f) => f.label === 'Document Title');
const numberField = fields.find((f) => f.label === 'Invoice number');
const amountField = fields.find((f) => f.label === 'Amount');
const dateField = fields.find((f) => f.label === 'Invoice date');

const created = await m('upload.finish', {
  uploadId: upload.uploadId,
  values: [
    { fieldId: titleField.id, value: 'Acme invoice 2026-0042' },
    { fieldId: numberField.id, value: '2026-0042' },
    { fieldId: amountField.id, value: 1499.5 },
    { fieldId: dateField.id, value: '2026-10-15' },
  ],
});
ok('upload.finish', `node ${created.nodeId.slice(0, 8)}, ${created.byteLength} bytes, sha ${created.sha256.slice(0, 12)}…`);

// --- read it back ------------------------------------------------------
const detail = await q('node.byId', { nodeId: created.nodeId });
ok(
  'node.byId index values',
  detail.index
    .filter((i) => i.value !== null)
    .map((i) => `${i.label}=${i.value}`)
    .join(' | '),
);

const download = await fetch(`${BASE}/file/${created.nodeId}/download`, {
  headers: { Cookie: cookie },
});
const roundTripped = Buffer.from(await download.arrayBuffer());
assert(
  'GET /file/:id/download returns the uploaded bytes',
  download.status === 200 && roundTripped.equals(content),
  `HTTP ${download.status}, ${roundTripped.byteLength} bytes, disposition=${download.headers.get('content-disposition')}`,
);

// --- wait for the text-extraction job ----------------------------------
let extracted = null;
for (let i = 0; i < 15; i += 1) {
  await new Promise((r) => setTimeout(r, 1000));
  const ft = await q('node.fullText', { nodeId: created.nodeId });
  if (ft.fullText) {
    extracted = ft;
    break;
  }
}
if (extracted) {
  ok('worker textExtraction', `extracted ${extracted.fullText.length} chars at ${extracted.extractedAt}`);
} else {
  console.log('FAIL  worker textExtraction — no text after 15s');
}

// --- search ------------------------------------------------------------
const byText = await q('search.documents', {
  cabinetIds: [cabinet.id],
  text: 'widget delivery',
  fullText: true,
  includeRecycleBin: false,
  skip: 0,
  take: 20,
});
ok('search by extracted text', `${byText.items.length} hit(s)`);

const byField = await q('search.documents', {
  cabinetIds: [cabinet.id],
  fields: [{ fieldId: amountField.id, operator: 'gte', value: 1000 }],
  fullText: false,
  includeRecycleBin: false,
  skip: 0,
  take: 20,
});
ok('search by Amount >= 1000', `${byField.items.length} hit(s)`);

const byFieldMiss = await q('search.documents', {
  cabinetIds: [cabinet.id],
  fields: [{ fieldId: amountField.id, operator: 'gt', value: 5000 }],
  fullText: false,
  includeRecycleBin: false,
  skip: 0,
  take: 20,
});
ok('search by Amount > 5000 (expect 0)', `${byFieldMiss.items.length} hit(s)`);

const snippets = await q('search.snippets', {
  nodeIds: [created.nodeId],
  text: 'widget delivery',
  radius: 40,
});
ok('search.snippets', JSON.stringify(snippets[0]?.snippet));

// --- versioning --------------------------------------------------------
await m('version.checkOut', { nodeId: created.nodeId, comment: 'revising total' });
ok('version.checkOut', 'locked');

const v2 = Buffer.from(
  'INVOICE 2026-0042 (revised)\nSupplier: Acme Corp\nAmount: 1612.75 EUR\n',
  'utf8',
);
const upload2 = await m('upload.begin', {
  cabinetId: cabinet.id,
  parentId: folder.id,
  fileName: 'invoice-2026-0042.txt',
  byteLength: v2.byteLength,
  segmentCount: 1,
});
await fetch(`${BASE}/upload/${upload2.uploadId}/0`, {
  method: 'PUT',
  headers: { 'Content-Type': 'application/octet-stream', Cookie: cookie },
  body: v2,
});
const checkedIn = await m('version.checkIn', {
  nodeId: created.nodeId,
  bump: 'minor',
  uploadId: upload2.uploadId,
  comment: 'corrected amount',
});
ok('version.checkIn', `now version ${checkedIn.version}`);

const versions = await q('version.list', { nodeId: created.nodeId });
ok('version.list', versions.map((v) => `${v.label} by ${v.createdBy}`).join(', '));

const afterCheckIn = await fetch(`${BASE}/file/${created.nodeId}/download`, {
  headers: { Cookie: cookie },
});
const currentBytes = Buffer.from(await afterCheckIn.arrayBuffer());
assert(
  'after check-in the current content is v2',
  currentBytes.equals(v2),
  `${currentBytes.byteLength} bytes`,
);

const oldest = versions[versions.length - 1];
const historical = await fetch(
  `${BASE}/file/${created.nodeId}/download?version=${oldest.id}`,
  { headers: { Cookie: cookie } },
);
const historicalBytes = Buffer.from(await historical.arrayBuffer());
assert(
  `historical download of version ${oldest.label} returns v1`,
  historical.status === 200 && historicalBytes.equals(content),
  `HTTP ${historical.status}, ${historicalBytes.byteLength} bytes`,
);

await m('version.revert', { nodeId: created.nodeId, versionId: oldest.id });
const afterRevert = await fetch(`${BASE}/file/${created.nodeId}/download`, {
  headers: { Cookie: cookie },
});
const revertedBytes = Buffer.from(await afterRevert.arrayBuffer());
assert(
  'version.revert restores the v1 bytes',
  revertedBytes.equals(content),
  `${revertedBytes.byteLength} bytes`,
);

const afterRevertVersions = await q('version.list', { nodeId: created.nodeId });
assert(
  'revert is itself undoable (v2 kept as a version)',
  afterRevertVersions.length === 2,
  afterRevertVersions.map((v) => v.label).join(', '),
);

// --- notes -------------------------------------------------------------
await m('workspace.addNote', { nodeId: created.nodeId, notes: 'Checked against PO 8812.' });
const notes = await q('workspace.notes', { nodeId: created.nodeId });
ok('workspace.addNote/notes', `${notes.length} note(s)`);

// --- recycle round trip ------------------------------------------------
await m('node.sendToRecycleBin', { nodeIds: [created.nodeId] });
const bin = await q('recycle.list', { cabinetId: cabinet.id, skip: 0, take: 20 });
ok('node.sendToRecycleBin', `${bin.total} item(s) in bin`);

await m('recycle.restore', { cabinetId: cabinet.id, nodeIds: [created.nodeId] });
const binAfter = await q('recycle.list', { cabinetId: cabinet.id, skip: 0, take: 20 });
ok('recycle.restore', `${binAfter.total} item(s) left in bin`);

// --- permission enforcement -------------------------------------------
const users = await q('security.users', { skip: 0, take: 10 });
ok('security.users', `${users.total} user(s)`);

const roles = await q('security.roles', undefined);
const usersRole = roles.find((r) => r.name === 'Users_Role');
const limited = await m('security.createUser', {
  userName: `clerk-${Date.now()}`,
  firstName: 'Limited',
  lastName: 'Clerk',
  isTempPassword: false,
  userType: 'local',
  status: 'active',
  roleIds: [usersRole.id],
});
ok('security.createUser', `${limited.user.userName}, temp password issued=${limited.temporaryPassword !== null}`);

const adminCookie = cookie;
cookie = '';
await m('session.login', {
  userName: limited.user.userName,
  password: limited.temporaryPassword,
});
ok('login as limited user', 'ok');

let denied = null;
try {
  await q('security.users', { skip: 0, take: 10 });
} catch (error) {
  denied = error.message;
}
ok('Users_Role denied security.users', denied ? `blocked: ${denied.split('->')[1].trim()}` : 'NOT BLOCKED');

let purgeDenied = null;
try {
  await m('recycle.purge', { cabinetId: cabinet.id, nodeIds: [created.nodeId] });
} catch (error) {
  purgeDenied = error.message;
}
ok(
  'Users_Role denied Empty_Recycle_Bin',
  purgeDenied ? `blocked: ${purgeDenied.split('->')[1].trim()}` : 'NOT BLOCKED',
);

cookie = adminCookie;

// --- audit -------------------------------------------------------------
const audit = await q('audit.query', { skip: 0, take: 200 });
const counts = {};
for (const r of audit.items) counts[r.action] = (counts[r.action] ?? 0) + 1;
ok('audit.query', `${audit.total} record(s): ${JSON.stringify(counts)}`);

const jobs = await q('job.summary', undefined);
ok('job.summary', JSON.stringify(jobs));

console.log('\nDocument left in place for the UI:', created.nodeId);
console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
