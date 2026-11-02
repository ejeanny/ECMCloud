/**
 * Runs the Prisma CLI with this repository's environment already in place.
 *
 * Two things the CLI does not do for us:
 *
 *   1. It loads `.env` from the schema's directory or the working directory,
 *      and this repository keeps its one env file at `apps/api/.env` so the
 *      API, the seed and the CLI cannot drift apart. The npm scripts hand that
 *      file to Node with `--env-file-if-exists`, which is why this wrapper is
 *      spawned rather than `prisma` directly.
 *
 *   2. `directUrl` in the schema is mandatory once declared, and against an
 *      ordinary PostgreSQL there is only one URL to give it. Defaulting it to
 *      `DATABASE_URL` here keeps a plain local server a one-variable setup,
 *      while Prisma Postgres sets both and gets the unpooled connection the
 *      CLI needs.
 *
 * Everything after the script name is passed through, so this is a drop-in
 * for `prisma`: `node scripts/prisma.mjs migrate dev --name add_thing`.
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);

if (!process.env.DATABASE_URL) {
  console.error(
    'DATABASE_URL is not set.\n' +
      'Put it in apps/api/.env, or pass it on the command line:\n' +
      '  DATABASE_URL=postgres://… npm run db:push -w @ecm/db',
  );
  process.exit(1);
}

// The pooled URL is safe for queries but not for migrations; see the comment
// on `directUrl` in schema.prisma.
if (!process.env.DIRECT_DATABASE_URL) {
  process.env.DIRECT_DATABASE_URL = process.env.DATABASE_URL;
}

/** The installed CLI's entry point, read from its own manifest. */
function prismaEntry() {
  const manifestPath = require.resolve('prisma/package.json');
  const manifest = require(manifestPath);
  const bin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.prisma;
  if (!bin) throw new Error('The installed prisma package declares no CLI entry point.');
  return path.join(path.dirname(manifestPath), bin);
}

const child = spawn(process.execPath, [prismaEntry(), ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: process.env,
});

child.on('close', (code, signal) => {
  // Re-raise a signal rather than reporting it as a clean exit, so Ctrl-C on a
  // long migration still looks like Ctrl-C to whatever ran npm.
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
