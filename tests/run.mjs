/**
 * Run every suite against a live API.
 *
 *   ECM_ADMIN_PASSWORD='…' npm test
 *
 * The suites are end to end on purpose: they sign in, upload real bytes, wait
 * for the worker, and read the result back over HTTP. They write into the
 * first cabinet `cabinet.list` returns and leave their documents behind, so
 * point them at a development database, never a real one.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { BASE } from './harness.mjs';

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));

/**
 * Suites, and whether each one needs a running API.
 *
 * Nearly all of them do: they are end to end on purpose. The converter suites
 * are the exception — they run on bytes, so they want neither a server nor a
 * password, and gating them behind one would mean nobody runs them.
 */
const SUITES = [
  ['tiff', 'TIFF converted to PDF, page geometry and streams', { api: false }],
  ['jpeg2000', 'JPEG 2000 carried into a PDF, header and geometry', { api: false }],
  ['flow', 'upload, index, search, versions, recycle'],
  ['restrictions', 'row-level view restrictions on every path'],
  ['annotations', 'annotations and XFDF'],
  ['burn', 'burning annotations into the page'],
  ['workflows', 'the workflow graph, branches and revisions'],
  ['tasktypes', 'what each workflow task type does'],
  ['triggers', 'workflow triggers firing'],
  ['retention', 'retention preview, recycle and permanent delete'],
];

function run(file, args = []) {
  return new Promise((resolve) => {
    // The converter suites import TypeScript straight from the web app, which
    // Node will do but warns about once per file; the warning is noise here.
    const flags = ['--no-warnings=MODULE_TYPELESS_PACKAGE_JSON'];
    const child = spawn(process.execPath, [...flags, path.join(here, file), ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('close', (code) => resolve({ code, out }));
  });
}

const only = process.argv.slice(2);
const selected = only.length > 0 ? SUITES.filter(([n]) => only.includes(n)) : SUITES;
const needsApi = selected.some(([, , options]) => options?.api !== false);

if (needsApi) {
  if (!process.env.ECM_ADMIN_PASSWORD) {
    console.error('Set ECM_ADMIN_PASSWORD to the password the seed was run with.');
    process.exit(2);
  }

  try {
    const health = await fetch(`${BASE}/health`);
    if (!health.ok) throw new Error(`HTTP ${health.status}`);
  } catch (error) {
    console.error(`No API on ${BASE} — start it with \`npm run dev:api\`. (${error.message})`);
    process.exit(2);
  }

  // The PDF suites need a real multi-page PDF; it is generated rather than
  // committed, so the bytes under test are never a stale checked-in blob.
  const pdf = path.join(here, 'fixtures', 'invoice.pdf');
  if (!existsSync(pdf)) {
    const made = await run(path.join('fixtures', 'make-pdf.mjs'), [pdf]);
    if (made.code !== 0) {
      console.error(made.out);
      process.exit(2);
    }
  }
}

let failed = 0;
for (const [name, what] of selected) {
  process.stdout.write(`\n── ${name} — ${what}\n`);
  const { code, out } = await run(`${name}.mjs`);
  const passes = (out.match(/^PASS /gm) ?? []).length;
  const fails = (out.match(/^FAIL /gm) ?? []).length;

  if (code === 0) {
    console.log(`   ${passes} checks passed`);
  } else {
    failed += 1;
    console.log(out.trimEnd());
    console.log(`   ${passes} passed, ${fails} failed`);
  }
}

console.log(
  failed === 0
    ? `\nAll ${selected.length} suites passed.`
    : `\n${failed} of ${selected.length} suites failed.`,
);
process.exit(failed === 0 ? 0 : 1);
