/**
 * Starts the API and the web app together.
 *
 * Not `npm run dev -w @ecm/api & npm run dev -w @ecm/web`, which only does what
 * it looks like on a POSIX shell: npm runs scripts through `cmd.exe` on
 * Windows, where `A & B` is a sequential separator rather than a backgrounding
 * one, so the API would start and the web app would never be reached.
 *
 * It also builds `@ecm/domain` first. The web app resolves that package to its
 * compiled output at run time (see the `paths` comment in
 * `apps/web/tsconfig.json`), so on a fresh clone the viewer and the workflow
 * designer would fail to load while the API's own watcher was still building
 * it.
 */
import { spawn } from 'node:child_process';

const WINDOWS = process.platform === 'win32';

/**
 * Each half is a tree — npm spawns a shell, which spawns tsc and next — and
 * signalling the top of it leaves the rest running on ports 3000 and 4000.
 * So each child gets a process group of its own that can be signalled whole.
 */
function run(args, { quiet = false } = {}) {
  return spawn('npm', args, {
    // npm is `npm.cmd` on Windows and needs a shell to resolve.
    shell: WINDOWS,
    detached: !WINDOWS,
    stdio: quiet ? ['ignore', 'ignore', 'inherit'] : 'inherit',
  });
}

function once(args, label) {
  return new Promise((resolve, reject) => {
    const child = run(args, { quiet: true });
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`${label} failed with exit code ${code}`)),
    );
  });
}

const children = [];
let stopping = false;

function stop() {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    try {
      if (WINDOWS) {
        // Windows has no process groups to signal; taskkill walks the tree.
        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
          stdio: 'ignore',
          shell: true,
        });
      } else {
        process.kill(-child.pid, 'SIGTERM');
      }
    } catch {
      // Already gone between the check and the signal; nothing to do.
    }
  }
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    stop();
    process.exit(0);
  });
}
process.on('exit', stop);

console.log('Building @ecm/domain…');
try {
  await once(['run', 'build', '-w', '@ecm/domain'], 'Building @ecm/domain');
} catch (cause) {
  console.error(String(cause instanceof Error ? cause.message : cause));
  process.exit(1);
}

console.log('Starting the API on :4000 and the web app on :3000 — Ctrl-C stops both.\n');
for (const workspace of ['@ecm/api', '@ecm/web']) {
  const child = run(['run', 'dev', '-w', workspace]);
  children.push(child);
  // If one half dies the other is useless on its own, and a half-running
  // stack is worse than a stopped one because it looks like it is working.
  child.on('close', (code) => {
    if (stopping) return;
    console.error(`\n${workspace} exited with code ${code}; stopping the other half.`);
    stop();
    process.exit(code ?? 1);
  });
}
