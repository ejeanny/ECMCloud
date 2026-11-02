// Retention: the one subsystem that deletes documents.
import { client, assert, finish } from './harness.mjs';
//
// What matters is that the preview tells the truth about what a run will do,
// that a document with no retention date is never swept up, and that a
// permanent delete does not take a blob another document is still using.
const admin = client();
await admin.m('session.login', { userName: 'admin', password: process.env.ECM_ADMIN_PASSWORD });
const cabinet = (await admin.q('cabinet.list', undefined))[0];
const fields = await admin.q('indexField.columns', { cabinetId: cabinet.id });
const invoiceDate = fields.find((f) => f.label === 'Invoice date');
const title = fields.find((f) => f.label === 'Document Title');
const supplier = fields.find((f) => f.label === 'Invoice supplier');
const stamp = new Date().toISOString().slice(11, 19).replace(/:/g, '');

// A folder of our own, so the rule's criteria can isolate this run's documents
// from every other document already in the cabinet.
const marker = `retention-${stamp}`;
const bytes = Buffer.from(`Retention test ${stamp}\n`, 'utf8');

async function upload(name, values) {
  const up = await admin.m('upload.begin', {
    cabinetId: cabinet.id,
    parentId: null,
    fileName: name,
    byteLength: bytes.byteLength,
    segmentCount: 1,
  });
  await admin.raw(`/upload/${up.uploadId}/0`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: bytes,
  });
  return (await admin.m('upload.finish', { uploadId: up.uploadId, values })).nodeId;
}

const tag = { fieldId: supplier.id, value: marker };
const iso = (daysAgo) =>
  new Date(Date.now() - daysAgo * 86400_000).toISOString().slice(0, 10);

// Three documents: one long past the cutoff, one well inside it, and one with
// no retention date at all.
const old = await upload(`ret-old-${stamp}.txt`, [
  tag,
  { fieldId: title.id, value: 'Old enough to expire' },
  { fieldId: invoiceDate.id, value: iso(800) },
]);
const recent = await upload(`ret-recent-${stamp}.txt`, [
  tag,
  { fieldId: title.id, value: 'Still inside the window' },
  { fieldId: invoiceDate.id, value: iso(10) },
]);
const undated = await upload(`ret-undated-${stamp}.txt`, [
  tag,
  { fieldId: title.id, value: 'No retention date at all' },
]);
assert('three documents uploaded', !!old && !!recent && !!undated);

/** A rule over this run's documents only. */
async function rule(name, action, extra = {}) {
  return admin.m('retention.save', {
    cabinetId: cabinet.id,
    name: `${name} ${stamp}`,
    isEnabled: true,
    expirationAction: action,
    years: 1,
    months: 0,
    days: 0,
    retentionDateFieldId: invoiceDate.id,
    combine: 'and',
    clauses: [{ fieldId: supplier.id, operator: 'eq', value: marker }],
    ...extra,
  });
}

// --- the preview ---------------------------------------------------------
const notifyRule = await rule('Notify on expiry', 'notify');
const preview = await admin.q('retention.expiredPreview', {
  cabinetId: cabinet.id,
  jobId: notifyRule.id,
});
const previewIds = preview.sample.map((s) => s.id);

assert('the preview finds the expired document', previewIds.includes(old));
assert('the preview leaves the one inside the window', !previewIds.includes(recent));
assert(
  'a document with no retention date is never expired',
  !previewIds.includes(undated),
  'absent from the preview',
);
assert('the preview counts exactly what it lists', preview.count === preview.sample.length, `${preview.count} vs ${preview.sample.length}`);
assert('the preview reports the action it would take', preview.expirationAction === 'notify');
assert(
  'and the cutoff is a year back',
  Math.abs(
    (Date.now() - new Date(preview.cutoff).getTime()) / 86400_000 - 365,
  ) < 3,
  new Date(preview.cutoff).toISOString().slice(0, 10),
);

// --- notify changes nothing ----------------------------------------------
await admin.m('retention.runNow', { jobId: notifyRule.id });
await new Promise((r) => setTimeout(r, 2500));
const stillThere = await admin.q('node.byId', { nodeId: old });
assert('a notify rule deletes nothing', stillThere.node.id === old && !stillThere.node.inRecycleBin);

const notes = await admin.q('notification.list', { skip: 0, take: 40, unreadOnly: false });
assert(
  'and it tells an administrator',
  (notes.items ?? notes).some((n) => n.type === 'retention' && n.message.includes(`Notify on expiry ${stamp}`)),
);

// --- recycle moves exactly the previewed documents -----------------------
const recycleRule = await rule('Recycle on expiry', 'recycle');
const beforeRecycle = await admin.q('retention.expiredPreview', {
  cabinetId: cabinet.id,
  jobId: recycleRule.id,
});
assert('the preview still names one document', beforeRecycle.count === 1, `${beforeRecycle.count}`);

await admin.m('retention.runNow', { jobId: recycleRule.id });
await new Promise((r) => setTimeout(r, 2500));

const recycled = await admin.q('node.byId', { nodeId: old });
assert('the expired document is in the recycle bin', recycled.node.inRecycleBin === true);
const untouched = await admin.q('node.byId', { nodeId: recent });
assert('the one inside the window is untouched', untouched.node.inRecycleBin === false);
const undatedStill = await admin.q('node.byId', { nodeId: undated });
assert('and so is the undated one', undatedStill.node.inRecycleBin === false);

const after = await admin.q('retention.expiredPreview', {
  cabinetId: cabinet.id,
  jobId: recycleRule.id,
});
assert(
  'a second run would find nothing — the bin is excluded',
  after.count === 0,
  `${after.count}`,
);

// Restore it for the permanent-delete test.
await admin.m('recycle.restore', { cabinetId: cabinet.id, nodeIds: [old] });
const restored = await admin.q('node.byId', { nodeId: old });
assert('and it restores out of the bin', restored.node.inRecycleBin === false);

// --- a permanent delete must not take a shared blob ----------------------
// A copy shares its source's blob, so purging one must leave the other
// readable — the reference count is the only thing standing between them.
const copied = await admin.m('node.copy', {
  nodeIds: [old],
  targetParentId: null,
});
const copyId = copied[0].id;
assert('a copy was made', !!copyId, String(copyId));

// The copy carries the same index values, so narrow the rule to the original.
const purgeRule = await admin.m('retention.save', {
  cabinetId: cabinet.id,
  name: `Purge on expiry ${stamp}`,
  isEnabled: true,
  expirationAction: 'deletePermanently',
  years: 1,
  months: 0,
  days: 0,
  retentionDateFieldId: invoiceDate.id,
  combine: 'and',
  clauses: [
    { fieldId: supplier.id, operator: 'eq', value: marker },
    { fieldId: title.id, operator: 'eq', value: 'Old enough to expire' },
  ],
});

// Rename the copy's title so only the original matches.
await admin.m('node.setIndexValues', {
  nodeId: copyId,
  values: [{ fieldId: title.id, value: 'The copy that must survive' }],
});

const purgePreview = await admin.q('retention.expiredPreview', {
  cabinetId: cabinet.id,
  jobId: purgeRule.id,
});
assert(
  'the preview names only the original, not the copy',
  purgePreview.count === 1 && purgePreview.sample[0].id === old,
  `${purgePreview.count} document(s)`,
);

await admin.m('retention.runNow', { jobId: purgeRule.id });
await new Promise((r) => setTimeout(r, 3500));

let goneProperly = false;
try {
  await admin.q('node.byId', { nodeId: old });
} catch (err) {
  goneProperly = err.code === 'NOT_FOUND';
}
assert('the expired document is permanently gone', goneProperly);

const copyStill = await admin.q('node.byId', { nodeId: copyId });
assert('the copy survives', copyStill.node.id === copyId);
const copyBytes = await admin.raw(`/file/${copyId}`, {});
assert(
  'and its bytes are still readable — the shared blob was not reclaimed',
  copyBytes.status === 200,
  `HTTP ${copyBytes.status}`,
);
assert(
  'byte for byte',
  Buffer.from(await copyBytes.arrayBuffer()).equals(bytes),
);

// --- a disabled rule does nothing ----------------------------------------
await admin.m('retention.save', {
  cabinetId: cabinet.id,
  jobId: recycleRule.id,
  name: `Recycle on expiry ${stamp}`,
  isEnabled: false,
  expirationAction: 'recycle',
  // One day, so everything in this run is past it — only `isEnabled` stands
  // between the rule and the whole set.
  years: 0,
  months: 0,
  days: 1,
  retentionDateFieldId: invoiceDate.id,
  combine: 'and',
  clauses: [{ fieldId: supplier.id, operator: 'eq', value: marker }],
});
await admin.m('retention.runNow', { jobId: recycleRule.id });
await new Promise((r) => setTimeout(r, 2500));
const survivedDisabled = await admin.q('node.byId', { nodeId: recent });
assert(
  'a disabled rule sweeps nothing, even with a zero-day period',
  survivedDisabled.node.inRecycleBin === false,
);

finish();
