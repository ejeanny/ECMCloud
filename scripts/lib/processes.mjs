/**
 * Running several long-lived dev processes from one npm script.
 *
 * Two things make this more than a `spawn` call.
 *
 * `A & B` cannot do it. npm runs scripts through `cmd.exe` on Windows, where
 * `&` is a sequential separator rather than a backgrounding one, so the second
 * command is only reached once the first exits — and a watcher never does.
 *
 * Signalling the child is not enough either. Each child is a tree (a shell,
 * which spawns tsc or next), and the shell does not forward signals, so the
 * processes actually holding the ports survive. Each child therefore gets a
 * process group of its own that can be signalled whole — on Windows, which has
 * no process groups, `taskkill /T` walks the tree instead.
 */
import { spawn } from 'node:child_process';

const WINDOWS = process.platform === 'win32';

/**
 * Commands are passed as one string, never as `(command, args, {shell:true})`:
 * that combination is deprecated (DEP0190) because the arguments are
 * concatenated rather than escaped. Everything here is a repo-local literal.
 */
function launch(command, { quiet = false } = {}) {
  return spawn(command, {
    shell: true,
    detached: !WINDOWS,
    stdio: quiet ? ['ignore', 'ignore', 'inherit'] : 'inherit',
  });
}

/** Runs a command to completion, rejecting on a non-zero exit. */
export function once(command, label = command) {
  return new Promise((resolve, reject) => {
    const child = launch(command, { quiet: true });
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`${label} failed with exit code ${code}`)),
    );
  });
}

/**
 * Starts every command, and keeps them together: Ctrl-C stops all of them, and
 * if one exits the rest are stopped too — a half-running stack is worse than a
 * stopped one, because it looks like it is working.
 */
export function runTogether(commands) {
  const children = [];
  let stopping = false;

  function stop() {
    if (stopping) return;
    stopping = true;
    for (const { child } of children) {
      if (child.exitCode !== null || child.signalCode !== null) continue;
      try {
        if (WINDOWS) {
          spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
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

  for (const entry of commands) {
    const { command, label } = typeof entry === 'string' ? { command: entry } : entry;
    const child = launch(command);
    children.push({ child, label: label ?? command });
    child.on('close', (code) => {
      if (stopping) return;
      console.error(`\n${label ?? command} exited with code ${code}; stopping the rest.`);
      stop();
      process.exit(code ?? 1);
    });
  }

  return stop;
}
