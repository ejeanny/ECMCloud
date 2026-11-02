// The workflow graph end to end: save a branching design with decision
import { client, assert, rejected, finish } from './harness.mjs';
// routings and canvas positions, read it back, publish it, and run a document
// through both branches. Covers what the designer needs the server to do.
const admin = client();
await admin.m('session.login', { userName: 'admin', password: process.env.ECM_ADMIN_PASSWORD });
const cabinet = (await admin.q('cabinet.list', undefined))[0];
const stamp = new Date().toISOString().slice(11, 19).replace(/:/g, '');

// --- assignee list, without User_Administration -------------------------
const assignees = await admin.q('workflow.assignees', { cabinetId: cabinet.id });
assert('workflow.assignees returns roles', assignees.roles.length >= 4, `${assignees.roles.length} roles`);
assert('workflow.assignees returns users', assignees.users.length >= 1, `${assignees.users.length} users`);
assert(
  'it returns labels only, not credentials',
  !JSON.stringify(assignees).toLowerCase().includes('password'),
);

const usersRole = assignees.roles.find((r) => r.name === 'Users_Role');

// --- a branching design -------------------------------------------------
const graph = {
  cabinetId: cabinet.id,
  name: `Invoice approval ${stamp}`,
  description: 'Drawn on the canvas',
  // Marked, not inferred: the reject edge below loops back to review-1, so
  // every task has an incoming routing and there is nothing to infer from.
  entryTaskKey: 'review-1',
  trigger: { onNewDocument: false, onIndexChanged: false, combine: 'and', clauses: [] },
  tasks: [
    { key: 'review-1', name: 'First review', type: 'review', assigneeRoleIds: [usersRole.id], assigneeUserIds: [], allowSpecificReviewer: false, config: {}, x: 0, y: 0 },
    { key: 'decision-1', name: 'Where next?', type: 'decision', assigneeRoleIds: [], assigneeUserIds: [], allowSpecificReviewer: false, config: {}, x: 260, y: 0 },
    { key: 'approval-1', name: 'Finance approval', type: 'approval', assigneeRoleIds: [], assigneeUserIds: [], allowSpecificReviewer: true, config: {}, x: 520, y: -70 },
    { key: 'notify-1', name: 'Tell the filer', type: 'notify', assigneeRoleIds: [], assigneeUserIds: [], allowSpecificReviewer: false, config: {}, x: 520, y: 90 },
  ],
  routings: [
    { fromTaskKey: 'review-1', toTaskKey: 'decision-1', type: 'always', decision: null, order: 0 },
    { fromTaskKey: 'decision-1', toTaskKey: 'approval-1', type: 'onDecision', decision: 'Send to finance', order: 0 },
    { fromTaskKey: 'decision-1', toTaskKey: 'notify-1', type: 'onDecision', decision: 'File it', order: 1 },
    { fromTaskKey: 'approval-1', toTaskKey: null, type: 'onApprove', decision: null, order: 0 },
    { fromTaskKey: 'approval-1', toTaskKey: 'review-1', type: 'onReject', decision: null, order: 1 },
  ],
};

const saved = await admin.m('workflow.save', graph);
assert('a branching design saves', saved.revision === 1, `r${saved.revision}`);

// --- read it back exactly ------------------------------------------------
const read = await admin.q('workflow.byId', { workflowId: saved.workflowId });
assert('all four tasks come back', read.tasks.length === 4);
assert('all five routings come back', read.routings.length === 5);

const positions = read.tasks.map((t) => `${t.key}:${t.x},${t.y}`).join(' ');
assert(
  'canvas positions survive the round trip',
  read.tasks.every((t) => t.x !== null && t.y !== null) &&
    read.tasks.find((t) => t.key === 'approval-1').y === -70,
  positions,
);

const decisions = read.routings.filter((r) => r.type === 'onDecision');
assert('both decision routings keep their choice', decisions.length === 2, decisions.map((r) => r.decision).join(' | '));
assert(
  'the choices are the exact wording',
  decisions.some((r) => r.decision === 'Send to finance') &&
    decisions.some((r) => r.decision === 'File it'),
);
assert(
  'a terminating routing stays null',
  read.routings.some((r) => r.fromTaskKey === 'approval-1' && r.type === 'onApprove' && r.toTaskKey === null),
);
assert('the declared entry survives', read.entryTaskKey === 'review-1', String(read.entryTaskKey));
assert(
  'assignee roles survive',
  read.tasks.find((t) => t.key === 'review-1').assigneeRoleIds[0] === usersRole.id,
);
assert(
  'allowSpecificReviewer survives',
  read.tasks.find((t) => t.key === 'approval-1').allowSpecificReviewer === true,
);

// --- validation the designer relies on ----------------------------------
await rejected(
  'a decision routing without a choice is refused',
  () =>
    admin.m('workflow.save', {
      ...graph,
      name: `bad-decision-${stamp}`,
      routings: [
        { fromTaskKey: 'review-1', toTaskKey: 'decision-1', type: 'onDecision', decision: null, order: 0 },
      ],
    }),
  'decision routing needs the choice',
);

await rejected(
  'a choice on a non-decision routing is refused',
  () =>
    admin.m('workflow.save', {
      ...graph,
      name: `bad-always-${stamp}`,
      routings: [
        { fromTaskKey: 'review-1', toTaskKey: 'decision-1', type: 'always', decision: 'nope', order: 0 },
      ],
    }),
  'Only a decision routing',
);

await rejected(
  'two routings with the same condition are refused',
  () =>
    admin.m('workflow.save', {
      ...graph,
      name: `ambiguous-${stamp}`,
      routings: [
        { fromTaskKey: 'review-1', toTaskKey: 'decision-1', type: 'always', decision: null, order: 0 },
        { fromTaskKey: 'review-1', toTaskKey: 'approval-1', type: 'always', decision: null, order: 1 },
      ],
    }),
  'would depend on their order',
);

await rejected(
  'an entry task that is not in the graph is refused',
  () => admin.m('workflow.save', { ...graph, name: `bad-entry-${stamp}`, entryTaskKey: 'ghost' }),
  'is not one of the tasks',
);

// The loop-back shape is the whole reason the entry is declared: without it,
// publish refuses the design every approval workflow actually has.
await rejected(
  'a loop-back design with no declared entry cannot be published',
  async () => {
    const orphan = await admin.m('workflow.save', {
      ...graph,
      name: `no-entry-${stamp}`,
      entryTaskKey: null,
    });
    await admin.m('workflow.publish', {
      cabinetId: cabinet.id,
      workflowId: orphan.workflowId,
      revision: orphan.revision,
    });
  },
  'none is marked as the start',
);

await rejected(
  'a routing to an unknown task is refused',
  () =>
    admin.m('workflow.save', {
      ...graph,
      name: `dangling-${stamp}`,
      routings: [
        { fromTaskKey: 'review-1', toTaskKey: 'ghost', type: 'always', decision: null, order: 0 },
      ],
    }),
  'unknown task',
);

// --- publish and run both branches --------------------------------------
await admin.m('workflow.publish', {
  cabinetId: cabinet.id,
  workflowId: saved.workflowId,
  revision: saved.revision,
});
const afterPublish = await admin.q('workflow.byId', { workflowId: saved.workflowId });
assert('the revision is published', afterPublish.published === true);

const content = Buffer.from(`Invoice for the workflow test ${stamp}\n`, 'utf8');
async function newDocument(name) {
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

/** Complete the open todo and report where the instance went. */
async function step(nodeId, decision, choice) {
  const instances = await admin.q('workflow.instancesForNode', { nodeId });
  const instance = instances[0];
  const open = instance.todos.find((t) => t.state === 'open');
  if (!open) return { state: instance.state, at: instance.currentTaskKey, done: true };
  await admin.m('workflow.completeTodo', {
    todoId: open.id,
    decision,
    ...(choice ? { choice } : {}),
  });
  const after = (await admin.q('workflow.instancesForNode', { nodeId }))[0];
  return { state: after.state, at: after.currentTaskKey };
}

// Branch one: the "Send to finance" choice, then approve, which terminates.
const docA = await newDocument(`wf-finance-${stamp}.txt`);
await admin.m('workflow.start', { cabinetId: cabinet.id, workflowId: saved.workflowId, nodeIds: [docA] });
let at = await step(docA, 'approve');
assert('the flow starts at the entry task and moves on', at.at === 'decision-1', `now at ${at.at}`);

at = await step(docA, 'choose', 'Send to finance');
assert('the "Send to finance" choice routes to approval', at.at === 'approval-1', `now at ${at.at}`);

at = await step(docA, 'approve');
assert(
  'approving follows the terminating routing and completes',
  at.state === 'completed' && at.at === null,
  `${at.state}, at ${at.at}`,
);

// Branch two: the other choice goes somewhere else entirely.
const docB = await newDocument(`wf-file-${stamp}.txt`);
await admin.m('workflow.start', { cabinetId: cabinet.id, workflowId: saved.workflowId, nodeIds: [docB] });
await step(docB, 'approve');
// "File it" routes to the notify task, which the engine runs itself and then
// moves on — with nothing after it, the instance finishes. The two choices
// reaching different outcomes is the point.
const branchB = await step(docB, 'choose', 'File it');
assert(
  'the "File it" choice routes elsewhere and runs straight through',
  branchB.state === 'completed' && branchB.at === null,
  `${branchB.state}, at ${branchB.at}`,
);

// Branch three: a rejection goes back round the loop the designer drew.
const docC = await newDocument(`wf-reject-${stamp}.txt`);
await admin.m('workflow.start', { cabinetId: cabinet.id, workflowId: saved.workflowId, nodeIds: [docC] });
await step(docC, 'approve');
await step(docC, 'choose', 'Send to finance');
const looped = await step(docC, 'reject');
assert(
  'rejecting at approval loops back to the first review',
  looped.at === 'review-1',
  `now at ${looped.at}`,
);

// --- saving forward creates a revision, leaving the published one alone --
const second = await admin.m('workflow.save', {
  ...graph,
  workflowId: saved.workflowId,
  tasks: graph.tasks.map((t) => (t.key === 'review-1' ? { ...t, name: 'Renamed review', x: 40 } : t)),
});
assert('saving again creates a new revision', second.revision === 2, `r${second.revision}`);

const published = await admin.q('workflow.byId', { workflowId: saved.workflowId, revision: 1 });
assert('the published revision is untouched', published.tasks.find((t) => t.key === 'review-1').name === 'First review');
const latest = await admin.q('workflow.byId', { workflowId: saved.workflowId });
assert('the new revision has the change', latest.tasks.find((t) => t.key === 'review-1').name === 'Renamed review');
assert('and the moved position', latest.tasks.find((t) => t.key === 'review-1').x === 40);
assert('the new revision is not published', latest.published === false);

console.log(`\nWorkflow id for the designer: ${saved.workflowId}`);
finish();
