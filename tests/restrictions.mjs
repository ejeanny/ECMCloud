// Row-level view restrictions.
//
// A restriction that only filters lists is not security: anyone who knows a
// document's id can still read it. This walks every path that returns a
// document, its metadata, or its bytes, as a user restricted to invoices
// under 1000, and checks the hidden one stays hidden.
import { readFileSync } from 'node:fs';
import { client, assert, hidden, finish } from './harness.mjs';

const admin = client();
await admin.m('session.login', { userName: 'admin', password: process.env.ECM_ADMIN_PASSWORD });
const cabinet = (await admin.q('cabinet.list', undefined))[0];
const fields = await admin.q('indexField.columns', { cabinetId: cabinet.id });
const amount = fields.find((f) => f.label === 'Amount');
const title = fields.find((f) => f.label === 'Document Title');
const stamp = new Date().toISOString().slice(11, 19).replace(/:/g, '');

// --- a role that may only see invoices under 1000 ------------------------
const role = await admin.m('security.createRole', {
  roleName: `Junior ${stamp}`,
  systemRights: [],
});
await admin.m('security.setCabinetRoleRights', {
  cabinetId: cabinet.id,
  roleId: role.id,
  rights: [
    'View_Open',
    'Launch_Document',
    'Launch_Viewer',
    'Folders_Files_View_Versions',
    'View_FileNotes',
    'Update_IndexValue',
    'Add_Annotation',
    'Export_Search_Results',
    'Edit_Document',
    'Edit_FileNotes',
  ],
  isReadOnly: false,
  isFileAccessDenied: false,
});
await admin.m('security.setViewRestriction', {
  cabinetId: cabinet.id,
  roleId: role.id,
  combine: 'and',
  clauses: [{ fieldId: amount.id, operator: 'lt', value: 1000 }],
});

const PASSWORD = 'Restriction-Test-Pass-1!';
const userName = `junior-${stamp}`;
await admin.m('security.createUser', {
  userName,
  password: PASSWORD,
  isTempPassword: false,
  roleIds: [role.id],
});

const junior = client();
await junior.m('session.login', { userName, password: PASSWORD });
assert('the restricted user can sign in', true, userName);

// --- two documents, one each side of the line ----------------------------
const bytes = Buffer.from(`Restriction test ${stamp}\n`, 'utf8');
async function upload(name, value) {
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
  return (
    await admin.m('upload.finish', {
      uploadId: up.uploadId,
      values: [
        { fieldId: title.id, value: name },
        { fieldId: amount.id, value },
      ],
    })
  ).nodeId;
}

const small = await upload(`restricted-small-${stamp}.txt`, 100);
const large = await upload(`restricted-large-${stamp}.txt`, 9999);
assert('two documents uploaded', !!small && !!large);

// --- what the restriction is supposed to do ------------------------------
const listed = await junior.q('node.list', {
  cabinetId: cabinet.id,
  parentId: null,
  inRecycleBin: false,
  skip: 0,
  take: 200,
  sortBy: 'modified',
  sortDir: 'desc',
});
const ids = (listed.items ?? listed).map((n) => n.id);
assert('the list shows the document under the threshold', ids.includes(small));
assert('and hides the one over it', !ids.includes(large));

const found = await junior.q('search.documents', {
  cabinetIds: [cabinet.id],
  text: 'restricted-',
  fields: [],
  skip: 0,
  take: 100,
});
const foundIds = (found.items ?? found).map((r) => r.id);
assert('search hides it too', !foundIds.includes(large), `${foundIds.length} hit(s)`);
assert('and search still finds the permitted one', foundIds.includes(small));

const exported = await junior.q('search.exportRows', {
  cabinetIds: [cabinet.id],
  text: 'restricted-',
  fields: [],
  skip: 0,
  take: 100,
});
assert(
  'the CSV export hides it as well',
  !JSON.stringify(exported).includes(`restricted-large-${stamp}`),
);

// --- and what it must also do: every path that takes an id ---------------
await hidden('node.byId does not return it', () =>
  junior.q('node.byId', { nodeId: large }),
);

await hidden('version.list does not return its versions', () =>
  junior.q('version.list', { nodeId: large }),
);

await hidden('workspace.notes does not return its notes', () =>
  junior.q('workspace.notes', { nodeId: large }),
);

await hidden('annotation.list does not return its annotations', () =>
  junior.q('annotation.list', { nodeId: large }),
);

await hidden('annotation.exportXfdf does not export it', () =>
  junior.q('annotation.exportXfdf', { nodeId: large }),
);

await hidden('workflow.instancesForNode does not return its instances', () =>
  junior.q('workflow.instancesForNode', { nodeId: large }),
);

await hidden('setIndexValues cannot edit it', () =>
  junior.m('node.setIndexValues', {
    nodeId: large,
    values: [{ fieldId: title.id, value: 'changed by someone who cannot see it' }],
  }),
);

await hidden('rename cannot touch it', () =>
  junior.m('node.rename', { nodeId: large, name: 'renamed.txt' }),
);

await hidden('touchRecent cannot record a view of it', () =>
  junior.m('workspace.touchRecent', { nodeId: large }),
);

await hidden('addNote cannot attach to it', () =>
  junior.m('workspace.addNote', { nodeId: large, notes: 'note' }),
);

// The bytes themselves.
const inline = await junior.raw(`/file/${large}`, {});
assert(
  'the inline file route does not serve its bytes',
  inline.status === 404,
  `HTTP ${inline.status}`,
);
const download = await junior.raw(`/file/${large}/download`, {});
assert(
  'the download route does not serve its bytes',
  download.status === 404,
  `HTTP ${download.status}`,
);

// --- the permitted document still works everywhere -----------------------
const ok = await junior.q('node.byId', { nodeId: small });
assert('the permitted document is still readable', ok.node.id === small);
const okFile = await junior.raw(`/file/${small}`, {});
assert('and its bytes still download', okFile.status === 200, `HTTP ${okFile.status}`);
const okVersions = await junior.q('version.list', { nodeId: small });
assert('and its versions still list', Array.isArray(okVersions));
await junior.m('workspace.touchRecent', { nodeId: small });
assert('and it can still be opened', true);

// --- favourites and recents must not leak it either ----------------------
// An administrator can favourite anything; the restricted user must not see
// the hidden one in their own lists even if it got there another way.
const recents = await junior.q('workspace.recents', { skip: 0, take: 100 });
assert(
  'recents show no hidden document',
  !(recents.items ?? []).some((r) => r.node.id === large),
);

// --- an administrator is unaffected --------------------------------------
const adminView = await admin.q('node.byId', { nodeId: large });
assert('an administrator still sees it', adminView.node.id === large);

finish();
