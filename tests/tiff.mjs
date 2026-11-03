/**
 * TIFF, converted to PDF.
 *
 * The one suite here that needs no API and no database: the converter runs in
 * the browser, on bytes, and it is pure enough to run under Node as well. That
 * is deliberate — a format reader is exactly the kind of code that wants
 * hundreds of cheap assertions rather than a handful of expensive ones.
 *
 * What is checked, for each fixture:
 *
 *   - the page count, and every page's box in points, which is where a file's
 *     resolution tags end up and where asymmetric fax resolution goes wrong
 *   - the image dictionary: filter, colour space, depth, and the
 *     CCITTFaxDecode parameters that say which fax coding this is
 *   - for a pass-through page, that the stream in the PDF is byte for byte the
 *     stream in the TIFF. That is the whole claim of the design: the scan's
 *     own data, carried across untouched, nothing decoded and nothing lost
 *   - for a decoded page, every sample, after undoing the Deflate
 *
 * The module under test is TypeScript, imported through Node's type stripping.
 * The resolve hook below is only there because the app's imports leave off the
 * file extension, which a bundler fills in and Node does not.
 *
 *   node tests/tiff.mjs
 */
import { registerHooks } from 'node:module';
import { inflateSync } from 'node:zlib';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { bigPage, fixtures, refusals } from './fixtures/make-tiffs.mjs';
import { pagesOf } from './read-pdf.mjs';

registerHooks({
  resolve(specifier, context, next) {
    if (/^\.{1,2}\//.test(specifier) && !/\.[cm]?[jt]s$/.test(specifier)) {
      return next(`${specifier}.ts`, context);
    }
    return next(specifier, context);
  },
});

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const module = path.join(here, '..', 'apps', 'web', 'src', 'lib', 'viewer', 'tiff.ts');
const { tiffToPdf } = await import(pathToFileURL(module).href);

let checks = 0;
let group = 'tiff';
let groupChecks = 0;
const failures = [];
const groupFailures = [];

function check(what, condition, detail = '') {
  checks++;
  groupChecks++;
  if (!condition) {
    const line = `${what}${detail ? ` — ${detail}` : ''}`;
    failures.push(line);
    groupFailures.push(line);
  }
}

/** One PASS or FAIL line per fixture, which is what `run.mjs` counts. */
function begin(name) {
  group = name;
  groupChecks = 0;
  groupFailures.length = 0;
}

function end() {
  if (groupFailures.length === 0) {
    console.log(`PASS ${group} (${groupChecks} checks)`);
  } else {
    console.log(`FAIL ${group}`);
    for (const failure of groupFailures) console.log(`       ${failure}`);
  }
}

function same(what, actual, expected) {
  check(what, actual === expected, `got ${actual}, wanted ${expected}`);
}

function close(what, actual, expected) {
  check(
    what,
    Math.abs(actual - expected) < 0.002,
    `got ${actual.toFixed(4)}, wanted ${expected.toFixed(4)}`,
  );
}

function sameBytes(what, actual, expected) {
  if (actual.length !== expected.length) {
    check(what, false, `${actual.length} bytes, wanted ${expected.length}`);
    return;
  }
  for (let i = 0; i < expected.length; i++) {
    if (actual[i] !== expected[i]) {
      check(what, false, `byte ${i} is ${actual[i]}, wanted ${expected[i]}`);
      return;
    }
  }
  check(what, true);
}

// --- the checks ---------------------------------------------------------

async function checkFixture({ name, bytes, pages: wanted }) {
  const result = await tiffToPdf(new Uint8Array(bytes));
  same(`${name}: page count`, result.pages, wanted.length);

  const pages = pagesOf(result.bytes);
  same(`${name}: pages written`, pages.length, wanted.length);

  wanted.forEach((want, index) => {
    const page = pages[index];
    if (!page) return;
    const at = `${name} p${index + 1}`;

    close(`${at}: page width`, page.size[0], want.size[0]);
    close(`${at}: page height`, page.size[1], want.size[1]);
    same(`${at}: image count`, page.images.length, want.images.length);

    want.images.forEach((wantImage, k) => {
      const image = page.images[k];
      if (!image) return;
      const where = `${at} image ${k}`;

      if (wantImage.filter) {
        check(
          `${where}: filter`,
          image.dict.includes(`/Filter/${wantImage.filter}`),
          image.dict.slice(0, 160),
        );
      }
      if (wantImage.space) {
        check(`${where}: colour space`, image.dict.includes(`/ColorSpace${wantImage.space}`));
      }
      if (wantImage.bits !== undefined) {
        check(
          `${where}: depth`,
          image.dict.includes(`/BitsPerComponent ${wantImage.bits}`),
          image.dict.slice(0, 160),
        );
      }
      if (wantImage.decode) {
        check(`${where}: decode array`, image.dict.includes(`/Decode${wantImage.decode}`));
      }
      for (const parm of wantImage.parms ?? []) {
        check(`${where}: ${parm}`, image.dict.includes(parm), image.dict.slice(0, 200));
      }
      for (const parm of wantImage.notParms ?? []) {
        check(`${where}: no ${parm}`, !image.dict.includes(parm));
      }
      if (wantImage.at) {
        wantImage.at.forEach((value, i) =>
          close(`${where}: placed [${i}]`, image.at[i], value),
        );
      }

      // The claim that matters: a pass-through page carries the scan's bytes.
      if (wantImage.stream) {
        sameBytes(`${where}: stream is the source stream`, image.stream, wantImage.stream);
      }
      if (wantImage.samples) {
        sameBytes(`${where}: samples`, inflateSync(Buffer.from(image.stream)), wantImage.samples);
      }
    });
  });
}

for (const fixture of fixtures()) {
  begin(fixture.name);
  try {
    await checkFixture(fixture);
  } catch (cause) {
    check(`${fixture.name}: converted`, false, `${cause.name}: ${cause.message}`);
  }
  end();
}

// The heavy page, checked the same way: 25MB of samples, every one of them.
begin('big-deflate-rgb.tif');
try {
  const big = bigPage();
  const started = Date.now();
  const result = await tiffToPdf(new Uint8Array(big.bytes));
  const ms = Date.now() - started;
  const [page] = pagesOf(result.bytes);
  close('big-deflate-rgb: page width', page.size[0], big.size[0]);
  close('big-deflate-rgb: page height', page.size[1], big.size[1]);
  sameBytes(
    'big-deflate-rgb: samples',
    inflateSync(Buffer.from(page.images[0].stream)),
    big.samples,
  );
  console.log(`       a 2550x3300 colour page converted in ${ms}ms`);
} catch (cause) {
  check('big-deflate-rgb: converted', false, `${cause.name}: ${cause.message}`);
}
end();

// And the files that must be refused rather than half-read.
begin('refusals');
for (const { name, bytes, because } of refusals()) {
  let message = null;
  try {
    await tiffToPdf(new Uint8Array(bytes));
  } catch (cause) {
    message = cause.message;
  }
  check(
    `refuses ${name}`,
    message !== null && message.includes(because),
    message === null ? 'it was accepted' : `said "${message}"`,
  );
}
end();

if (failures.length > 0) {
  console.error(`${failures.length} of ${checks} checks failed`);
  process.exit(1);
}
console.log(`${checks} checks passed`);
