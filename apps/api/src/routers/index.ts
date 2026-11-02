import { router } from '../trpc.js';
import { auditRouter, jobRouter, notificationRouter, retentionRouter } from './admin.js';
import { annotationRouter } from './annotation.js';
import { cabinetRouter } from './cabinet.js';
import { indexFieldRouter } from './index-field.js';
import { nodeRouter } from './node.js';
import { recycleRouter } from './recycle.js';
import { searchRouter } from './search.js';
import { securityRouter } from './security.js';
import { sessionRouter } from './session.js';
import { uploadRouter } from './upload.js';
import { versionRouter } from './version.js';
import { workflowRouter } from './workflow.js';
import { workspaceRouter } from './workspace.js';

/**
 * The API, grouped the way Dokmee's controllers are (§3). Dokmee's routes were
 * already RPC-shaped (`{controller}/{action}`), so `node.list` here stands
 * where `FileSystem/GetPagedDocumentsAsync` stood.
 */
export const appRouter = router({
  session: sessionRouter,
  cabinet: cabinetRouter,
  indexField: indexFieldRouter,
  node: nodeRouter,
  upload: uploadRouter,
  version: versionRouter,
  recycle: recycleRouter,
  search: searchRouter,
  workspace: workspaceRouter,
  security: securityRouter,
  audit: auditRouter,
  retention: retentionRouter,
  notification: notificationRouter,
  job: jobRouter,
  workflow: workflowRouter,
  annotation: annotationRouter,
});

export type AppRouter = typeof appRouter;
