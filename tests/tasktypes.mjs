// What each workflow task type actually does. Every type the designer offers
import { client, assert, finish } from './harness.mjs';
// must either wait for a person, run and move on, or stop with the reason it
// cannot run — never sit in someone's inbox pretending to be work.
const admin = client();
await admin.m('session.login', { userName: 'admin', password: process.env.ECM_ADMIN_PASSWORD });
const cabinet = (await admin.q('cabinet.list', undefined))[0];
const fields = await admin.q('indexField.columns', { cabinetId: cabinet.id });
const title = fields.find((f) => f.label === 'Document Title');
const supplier = fields.find((f) => f.label === 'Invoice supplier');
const stamp = new Date().toISOString().slice(11, 19).replace(/:/g, '');
const content = Buffer.from(`Task type test ${stamp}\n`, 'utf8');

async function upload(name) {
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
  return (await admin.m('upload.finish', { uploadId: up.uploadId, values: [] })).nodeId;
}

const task = (key, type, extra = {}) => ({
  key,
  name: `${type} step`,
  type,
  assigneeRoleIds: [],
  assigneeUserIds: [],
  allowSpecificReviewer: false,
  config: {},
  x: 0,
  y: 0,
  ...extra,
});

async function publishFlow(name, tasks, routings) {
  const saved = await admin.m('workflow.save', {
    cabinetId: cabinet.id,
    name: `${name} ${stamp}`,
    entryTaskKey: tasks[0].key,
    trigger: { onNewDocument: false, onIndexChanged: false, combine: 'and', clauses: [] },
    tasks,
    routings,
  });
  await admin.m('workflow.publish', {
    cabinetId: cabinet.id,
    workflowId: saved.workflowId,
    revision: saved.revision,
  });
  return saved.workflowId;
}

async function runOn(workflowId, nodeId) {
  await admin.m('workflow.start', { cabinetId: cabinet.id, workflowId, nodeIds: [nodeId] });
  const all = await admin.q('workflow.instancesForNode', { nodeId });
  return all.find((i) => i.workflow.id === workflowId);
}

// --- a human task waits --------------------------------------------------
const humanFlow = await publishFlow(
  'Human waits',
  [task('review-1', 'review')],
  [{ fromTaskKey: 'review-1', toTaskKey: null, type: 'always', decision: null, order: 0 }],
);
const humanDoc = await upload(`tt-human-${stamp}.txt`);
const human = await runOn(humanFlow, humanDoc);
assert('a review task waits for someone', human.state === 'running', human.state);
assert('and leaves a to-do', human.todos.filter((t) => t.state === 'open').length === 1);

// --- notify runs and moves straight on -----------------------------------
const notifyFlow = await publishFlow(
  'Notify then wait',
  [
    task('notify-1', 'notify', { config: { message: `Filed and logged ${stamp}` } }),
    task('review-1', 'review'),
  ],
  [
    { fromTaskKey: 'notify-1', toTaskKey: 'review-1', type: 'always', decision: null, order: 0 },
    { fromTaskKey: 'review-1', toTaskKey: null, type: 'always', decision: null, order: 0 },
  ],
);
const notifyDoc = await upload(`tt-notify-${stamp}.txt`);
const notified = await runOn(notifyFlow, notifyDoc);
assert(
  'a notify task does not wait — the flow is already at the next step',
  notified.currentTaskKey === 'review-1',
  `at ${notified.currentTaskKey}`,
);
assert(
  'and it left no to-do of its own',
  notified.todos.every((t) => t.task.type !== 'notify'),
  notified.todos.map((t) => t.task.type).join(', ') || 'none',
);

const notes = await admin.q('notification.list', { skip: 0, take: 30, unreadOnly: false });
assert(
  'the notification was actually sent',
  (notes.items ?? notes).some((n) => n.message === `Filed and logged ${stamp}`),
  'found the configured message',
);

// --- updateIndex writes the value ----------------------------------------
const indexFlow = await publishFlow(
  'Set a value',
  [
    task('updateIndex-1', 'updateIndex', {
      config: { values: [{ fieldId: supplier.id, value: `Set by workflow ${stamp}` }] },
    }),
    task('review-1', 'review'),
  ],
  [
    { fromTaskKey: 'updateIndex-1', toTaskKey: 'review-1', type: 'always', decision: null, order: 0 },
    { fromTaskKey: 'review-1', toTaskKey: null, type: 'always', decision: null, order: 0 },
  ],
);
const indexDoc = await upload(`tt-index-${stamp}.txt`);
const indexed = await runOn(indexFlow, indexDoc);
assert('an updateIndex task does not wait', indexed.currentTaskKey === 'review-1', `at ${indexed.currentTaskKey}`);

const detail = await admin.q('node.byId', { nodeId: indexDoc });
const written = detail.index.find((f) => f.fieldId === supplier.id || f.label === 'Invoice supplier');
assert(
  'and the index value is on the document',
  String(written?.value ?? '') === `Set by workflow ${stamp}`,
  JSON.stringify(written?.value),
);

// --- end completes the instance ------------------------------------------
const endFlow = await publishFlow(
  'Ends early',
  [task('review-1', 'review'), task('end-1', 'end')],
  [
    { fromTaskKey: 'review-1', toTaskKey: 'end-1', type: 'always', decision: null, order: 0 },
  ],
);
const endDoc = await upload(`tt-end-${stamp}.txt`);
const started = await runOn(endFlow, endDoc);
const open = started.todos.find((t) => t.state === 'open');
await admin.m('workflow.completeTodo', { todoId: open.id, decision: 'approve' });
const ended = (await admin.q('workflow.instancesForNode', { nodeId: endDoc })).find(
  (i) => i.workflow.id === endFlow,
);
assert('an end task completes the instance', ended.state === 'completed', ended.state);
assert('and leaves no open to-do', !ended.todos.some((t) => t.state === 'open'));

// --- a chain of automatic steps runs through -----------------------------
const chainFlow = await publishFlow(
  'All automatic',
  [
    task('notify-1', 'notify'),
    task('updateIndex-1', 'updateIndex', {
      config: { values: [{ fieldId: title.id, value: `Chained ${stamp}` }] },
    }),
    task('end-1', 'end'),
  ],
  [
    { fromTaskKey: 'notify-1', toTaskKey: 'updateIndex-1', type: 'always', decision: null, order: 0 },
    { fromTaskKey: 'updateIndex-1', toTaskKey: 'end-1', type: 'always', decision: null, order: 0 },
  ],
);
const chainDoc = await upload(`tt-chain-${stamp}.txt`);
const chained = await runOn(chainFlow, chainDoc);
assert(
  'a chain of automatic steps runs to the end in one go',
  chained.state === 'completed',
  chained.state,
);
const chainDetail = await admin.q('node.byId', { nodeId: chainDoc });
assert(
  'every step in the chain had its effect',
  String(chainDetail.index.find((f) => f.label === 'Document Title')?.value ?? '') ===
    `Chained ${stamp}`,
);

// --- a type needing an engine stops, saying so ---------------------------
for (const [type, expect] of [
  ['stamp', 'stamp subsystem'],
  ['signature', 'signing provider'],
  ['email', 'SMTP'],
  ['rpa', 'RPA runner'],
  ['clone', 'copy target'],
]) {
  const flow = await publishFlow(`Needs ${type}`, [task(`${type}-1`, type)], []);
  const doc = await upload(`tt-${type}-${stamp}.txt`);
  const run = await runOn(flow, doc);
  assert(
    `a ${type} task stops the instance with its reason`,
    run.state === 'error' && (run.error ?? '').includes(expect),
    `${run.state}: ${run.error ?? '(none)'}`,
  );
  assert(`and a ${type} task leaves nobody a to-do`, !run.todos.some((t) => t.state === 'open'));
}

// --- a misconfigured automatic step stops too ----------------------------
const badFlow = await publishFlow(
  'Nothing to set',
  [task('updateIndex-1', 'updateIndex')],
  [],
);
const badDoc = await upload(`tt-bad-${stamp}.txt`);
const bad = await runOn(badFlow, badDoc);
assert(
  'an update-index step with nothing configured stops, rather than doing nothing quietly',
  bad.state === 'error' && (bad.error ?? '').includes('no values configured'),
  `${bad.state}: ${bad.error ?? '(none)'}`,
);

// --- a loop of automatic steps is caught ---------------------------------
const loopFlow = await publishFlow(
  'Automatic loop',
  [task('notify-1', 'notify'), task('notify-2', 'notify')],
  [
    { fromTaskKey: 'notify-1', toTaskKey: 'notify-2', type: 'always', decision: null, order: 0 },
    { fromTaskKey: 'notify-2', toTaskKey: 'notify-1', type: 'always', decision: null, order: 0 },
  ],
);
const loopDoc = await upload(`tt-loop-${stamp}.txt`);
const looped = await runOn(loopFlow, loopDoc);
assert(
  'a loop of automatic steps halts instead of spinning',
  looped.state === 'error' && (looped.error ?? '').includes('loops'),
  `${looped.state}: ${looped.error ?? '(none)'}`,
);

finish();
