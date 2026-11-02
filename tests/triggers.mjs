// Triggers: a published workflow that starts itself when a matching document
// arrives, and stays out of the way when one does not.
import { readFileSync } from 'node:fs';
import { client, assert, rejected, finish } from './harness.mjs';
const admin = client();
await admin.m('session.login', { userName: 'admin', password: process.env.ECM_ADMIN_PASSWORD });
const cabinet = (await admin.q('cabinet.list', undefined))[0];
const fields = await admin.q('indexField.columns', { cabinetId: cabinet.id });
const amount = fields.find((f) => f.label === 'Amount');
const title = fields.find((f) => f.label === 'Document Title');
const stamp = new Date().toISOString().slice(11, 19).replace(/:/g, '');
assert('the cabinet has fields to test', !!amount && !!title, fields.map((f) => f.label).join(', '));

function design(name, trigger) {
  return {
    cabinetId: cabinet.id,
    name,
    entryTaskKey: 'review-1',
    trigger,
    tasks: [
      { key: 'review-1', name: 'Check it', type: 'review', assigneeRoleIds: [], assigneeUserIds: [], allowSpecificReviewer: false, config: {}, x: 0, y: 0 },
    ],
    routings: [{ fromTaskKey: 'review-1', toTaskKey: null, type: 'always', decision: null, order: 0 }],
  };
}

// --- a trigger narrowed by an index value --------------------------------
const big = await admin.m(
  'workflow.save',
  design(`Big invoices ${stamp}`, {
    onNewDocument: true,
    onIndexChanged: false,
    combine: 'and',
    clauses: [{ fieldId: amount.id, operator: 'gte', value: 1000 }],
  }),
);
await admin.m('workflow.publish', {
  cabinetId: cabinet.id,
  workflowId: big.workflowId,
  revision: big.revision,
});
assert('a conditional trigger saves and publishes', big.revision === 1);

const readBack = await admin.q('workflow.byId', { workflowId: big.workflowId });
assert('onNewDocument survives', readBack.trigger.onNewDocument === true);
assert('the condition survives', readBack.trigger.clauses.length === 1, JSON.stringify(readBack.trigger.clauses));
assert(
  'the condition keeps its field, operator and value',
  readBack.trigger.clauses[0].fieldId === amount.id &&
    readBack.trigger.clauses[0].operator === 'gte' &&
    Number(readBack.trigger.clauses[0].value) === 1000,
);

const content = Buffer.from(`Trigger test ${stamp}\n`, 'utf8');
async function upload(name, values) {
  const up = await admin.m('upload.begin', {
    cabinetId: cabinet.id,
    parentId: null,
    fileName: name,
    byteLength: content.byteLength,
    segmentCount: 1,
  });
  await admin.raw(`/upload/${up.uploadId}/0`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: content,
  });
  return (await admin.m('upload.finish', { uploadId: up.uploadId, values })).nodeId;
}

/** Instances of one workflow on one document, once the worker has caught up. */
async function instancesOf(nodeId, workflowId, expect) {
  for (let i = 0; i < 16; i++) {
    const all = await admin.q('workflow.instancesForNode', { nodeId });
    const mine = all.filter((x) => x.workflow.id === workflowId);
    if (mine.length >= expect) return mine;
    await new Promise((r) => setTimeout(r, 600));
  }
  return (await admin.q('workflow.instancesForNode', { nodeId })).filter(
    (x) => x.workflow.id === workflowId,
  );
}

// Over the threshold: it should start on its own.
const over = await upload(`trigger-over-${stamp}.txt`, [
  { fieldId: title.id, value: 'Large invoice' },
  { fieldId: amount.id, value: 2500 },
]);
const started = await instancesOf(over, big.workflowId, 1);
assert('a matching document starts the workflow by itself', started.length === 1, `${started.length} instance(s)`);
assert('it is waiting at the entry task', started[0]?.todos.some((t) => t.state === 'open'), started[0]?.state);

// A PDF has no text extractor here. Triggering used to hang off the end of
// text extraction, so this — most of what an ECM actually holds — fired
// nothing at all.
const pdfBytes = readFileSync(new URL('./fixtures/invoice.pdf', import.meta.url));
const pdfUpload = await admin.m('upload.begin', {
  cabinetId: cabinet.id,
  parentId: null,
  fileName: `trigger-pdf-${stamp}.pdf`,
  byteLength: pdfBytes.byteLength,
  segmentCount: 1,
});
await admin.raw(`/upload/${pdfUpload.uploadId}/0`, {
  method: 'PUT',
  headers: { 'Content-Type': 'application/octet-stream' },
  body: pdfBytes,
});
const pdfNode = (
  await admin.m('upload.finish', {
    uploadId: pdfUpload.uploadId,
    values: [
      { fieldId: title.id, value: 'Scanned invoice' },
      { fieldId: amount.id, value: 4000 },
    ],
  })
).nodeId;
const pdfStarted = await instancesOf(pdfNode, big.workflowId, 1);
assert(
  'a PDF triggers too, though nothing can read its text',
  pdfStarted.length === 1,
  `${pdfStarted.length} instance(s)`,
);

// Under the threshold: it must stay out of the way.
const under = await upload(`trigger-under-${stamp}.txt`, [
  { fieldId: title.id, value: 'Small invoice' },
  { fieldId: amount.id, value: 20 },
]);
await new Promise((r) => setTimeout(r, 2500));
const quiet = (await admin.q('workflow.instancesForNode', { nodeId: under })).filter(
  (x) => x.workflow.id === big.workflowId,
);
assert('a document below the threshold starts nothing', quiet.length === 0, `${quiet.length} instance(s)`);

// --- changing an index value fires the other event -----------------------
const onChange = await admin.m(
  'workflow.save',
  design(`Reindexed ${stamp}`, {
    onNewDocument: false,
    onIndexChanged: true,
    combine: 'and',
    clauses: [{ fieldId: title.id, operator: 'contains', value: 'urgent' }],
  }),
);
await admin.m('workflow.publish', {
  cabinetId: cabinet.id,
  workflowId: onChange.workflowId,
  revision: onChange.revision,
});

const plain = await upload(`trigger-reindex-${stamp}.txt`, [
  { fieldId: title.id, value: 'Ordinary paperwork' },
]);
await new Promise((r) => setTimeout(r, 1500));
const beforeEdit = (await admin.q('workflow.instancesForNode', { nodeId: plain })).filter(
  (x) => x.workflow.id === onChange.workflowId,
);
assert('nothing starts while the value does not match', beforeEdit.length === 0);

await admin.m('node.setIndexValues', {
  nodeId: plain,
  values: [{ fieldId: title.id, value: 'Now urgent paperwork' }],
});
const afterEdit = await instancesOf(plain, onChange.workflowId, 1);
assert(
  'editing the value into a match starts the workflow',
  afterEdit.length === 1,
  `${afterEdit.length} instance(s)`,
);

// --- a trigger with no event stays manual --------------------------------
const manual = await admin.m(
  'workflow.save',
  design(`Manual only ${stamp}`, {
    onNewDocument: false,
    onIndexChanged: false,
    combine: 'and',
    clauses: [],
  }),
);
await admin.m('workflow.publish', {
  cabinetId: cabinet.id,
  workflowId: manual.workflowId,
  revision: manual.revision,
});
const ignored = await upload(`trigger-manual-${stamp}.txt`, [
  { fieldId: title.id, value: 'Nothing special' },
]);
await new Promise((r) => setTimeout(r, 2500));
const none = (await admin.q('workflow.instancesForNode', { nodeId: ignored })).filter(
  (x) => x.workflow.id === manual.workflowId,
);
assert('a workflow with no event ticked never fires on its own', none.length === 0);

const byHand = await admin.m('workflow.start', {
  cabinetId: cabinet.id,
  workflowId: manual.workflowId,
  nodeIds: [ignored],
});
assert('but it still starts by hand', byHand.instanceIds.length === 1);

// --- conditions are checked at save, not at upload time ------------------
await rejected(
  'an operator the field type cannot answer is refused at save',
  () =>
    admin.m(
      'workflow.save',
      design(`Bad operator ${stamp}`, {
        onNewDocument: true,
        onIndexChanged: false,
        combine: 'and',
        // `contains` is a text operator; Amount is numeric.
        clauses: [{ fieldId: amount.id, operator: 'contains', value: 'x' }],
      }),
    ),
  'cannot be evaluated',
);

await rejected(
  'a condition on a field from another cabinet is refused',
  () =>
    admin.m(
      'workflow.save',
      design(`Foreign field ${stamp}`, {
        onNewDocument: true,
        onIndexChanged: false,
        combine: 'and',
        clauses: [{ fieldId: crypto.randomUUID(), operator: 'eq', value: 'x' }],
      }),
    ),
  'not in this cabinet',
);

console.log(`\nTrigger workflow for the designer: ${big.workflowId}`);
finish();
