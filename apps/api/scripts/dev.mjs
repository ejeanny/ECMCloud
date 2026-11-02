/**
 * The API in watch mode.
 *
 * It is not run from `src` directly. The source carries `.js` import
 * specifiers because it is written for the compiled output, and Node's type
 * stripping does not rewrite a `.js` specifier to the `.ts` beside it — so
 * `node --experimental-strip-types src/server.ts` dies on the first import.
 *
 * Instead `tsc` keeps `dist/` current and `node --watch` restarts on it. The
 * one-off build comes first because `node --watch` started against a `dist/`
 * that does not exist yet fails and then waits on a file it never loaded, so
 * it never picks the build up.
 */
import { once, runTogether } from '../../../scripts/lib/processes.mjs';

try {
  await once('tsc -b', 'Building @ecm/api');
} catch (cause) {
  console.error(String(cause instanceof Error ? cause.message : cause));
  process.exit(1);
}

runTogether([
  { command: 'tsc -b --watch --preserveWatchOutput', label: 'tsc' },
  {
    command: 'node --env-file-if-exists=.env --watch --watch-preserve-output dist/server.js',
    label: 'api',
  },
]);
