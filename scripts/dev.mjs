/**
 * Starts the API and the web app together.
 *
 * `@ecm/domain` is built first: the web app resolves that package to its
 * compiled output at run time (see the `paths` comment in
 * `apps/web/tsconfig.json`), so on a fresh clone the viewer and the workflow
 * designer would fail to load while the API's own watcher was still building
 * it.
 */
import { once, runTogether } from './lib/processes.mjs';

console.log('Building @ecm/domain…');
try {
  await once('npm run build -w @ecm/domain', 'Building @ecm/domain');
} catch (cause) {
  console.error(String(cause instanceof Error ? cause.message : cause));
  process.exit(1);
}

console.log('Starting the API on :4000 and the web app on :3000 — Ctrl-C stops both.\n');
runTogether([
  { command: 'npm run dev -w @ecm/api', label: '@ecm/api' },
  { command: 'npm run dev -w @ecm/web', label: '@ecm/web' },
]);
