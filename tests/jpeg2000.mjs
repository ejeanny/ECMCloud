/**
 * JPEG 2000, converted to PDF.
 *
 * **What this suite does not do.** It never decodes a JPEG 2000 image, because
 * there is no JPEG 2000 encoder on a developer machine and a wavelet
 * codestream cannot be written by hand the way the fax codes in
 * `fixtures/make-tiffs.mjs` can. Every fixture here carries a *header* that is
 * correct and a payload that is filler.
 *
 * That is a real limit, and worth stating rather than hiding: these checks
 * establish that the right bytes reach the PDF with the right geometry around
 * them, not that a picture appears. The decoding itself is OpenJPEG's, shipped
 * with PDF.js as WebAssembly, and the conversion deliberately does none of it.
 *
 * What is checked is what this code actually does:
 *
 *   - the size read from the codestream's SIZ marker, including the reference
 *     grid offset that makes `Xsiz` alone wrong
 *   - the same for a `.jp2` wrapper, where the marker sits inside a box
 *   - the page box, from the capture-resolution box when the file has one.
 *     Vertical comes first inside that box, the reverse of everywhere else,
 *     so a non-square fixture is here to catch the swap
 *   - that the stream in the PDF is byte for byte the file that went in
 *   - that the image declares no colour space and no depth, which for
 *     JPXDecode is what the specification asks for
 *
 *   node tests/jpeg2000.mjs
 */
import { registerHooks } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

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
const module = path.join(here, '..', 'apps', 'web', 'src', 'lib', 'viewer', 'jpeg2000.ts');
const { jpeg2000ToPdf } = await import(pathToFileURL(module).href);

let checks = 0;
const failures = [];

function check(what, condition, detail = '') {
  checks++;
  if (!condition) failures.push(`${what}${detail ? ` — ${detail}` : ''}`);
}

function close(what, actual, expected) {
  check(
    what,
    Math.abs(actual - expected) < 0.002,
    `got ${actual.toFixed(4)}, wanted ${expected.toFixed(4)}`,
  );
}

const group = [];
function report(name, before) {
  const mine = failures.slice(before);
  if (mine.length === 0) {
    console.log(`PASS ${name} (${checks - group.at(-1)} checks)`);
  } else {
    console.log(`FAIL ${name}`);
    for (const failure of mine) console.log(`       ${failure}`);
  }
}

// --- building headers ---------------------------------------------------

const u8 = (...values) => Buffer.from(values);
const u16 = (value) => {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(value);
  return b;
};
const u32 = (value) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(value);
  return b;
};

/**
 * A codestream: the start marker, a correct SIZ segment, and filler.
 *
 * The filler stands in for the coded wavelet data. Nothing in the conversion
 * reads past SIZ, which is exactly why the conversion is cheap.
 */
function codestream({ xsiz, ysiz, xo = 0, yo = 0, components = 3 }) {
  const siz = Buffer.concat([
    u16(38 + 3 * components), // Lsiz
    u16(0), // Rsiz
    u32(xsiz), u32(ysiz), u32(xo), u32(yo),
    u32(xsiz), u32(ysiz), u32(0), u32(0), // one tile covering the grid
    u16(components),
    ...Array.from({ length: components }, () => u8(7, 1, 1)), // Ssiz, XRsiz, YRsiz
  ]);
  return Buffer.concat([
    u8(0xff, 0x4f), // start of codestream
    u8(0xff, 0x51), // size marker
    siz,
    u8(0xff, 0x93), // start of data, then filler standing in for coded data
    Buffer.alloc(64, 0x5a),
    u8(0xff, 0xd9), // end of codestream
  ]);
}

const box = (type, payload) =>
  Buffer.concat([u32(payload.length + 8), Buffer.from(type, 'latin1'), payload]);

/** The capture-resolution box: vertical first, then horizontal. */
const resc = ({ vertical, horizontal, exponent = 0 }) =>
  box(
    'resc',
    Buffer.concat([
      u16(vertical), u16(1), u16(horizontal), u16(1),
      u8(exponent), u8(exponent),
    ]),
  );

/** A `.jp2` file: signature, file type, the header superbox, the codestream. */
function jp2({ xsiz, ysiz, components = 3, resolution = null, resolutionType = 'resc' }) {
  const header = [
    box('ihdr', Buffer.concat([u32(ysiz), u32(xsiz), u16(components), u8(7), u8(7), u8(0), u8(0)])),
    box('colr', Buffer.concat([u8(1), u8(0), u8(0), u32(components === 1 ? 17 : 16)])),
  ];
  if (resolution) {
    const inner = resc(resolution);
    // Same payload either way; the type decides which box it is.
    inner.write(resolutionType, 4, 'latin1');
    header.push(box('res ', inner));
  }

  return Buffer.concat([
    Buffer.from([0x00, 0x00, 0x00, 0x0c, 0x6a, 0x50, 0x20, 0x20, 0x0d, 0x0a, 0x87, 0x0a]),
    box('ftyp', Buffer.concat([Buffer.from('jp2 '), u32(0), Buffer.from('jp2 ')])),
    box('jp2h', Buffer.concat(header)),
    box('jp2c', codestream({ xsiz, ysiz, components })),
  ]);
}

/** Pixels per metre for a resolution in dots per inch, where it is exact. */
const ppm = (dpi) => dpi / 0.0254;

// --- the cases ----------------------------------------------------------

/**
 * Each case is a file, the pixel size it must be read as, and the page box in
 * points that must come out.
 */
const cases = [
  {
    name: 'bare codestream',
    bytes: codestream({ xsiz: 640, ysiz: 480 }),
    pixels: [640, 480],
    // No resolution anywhere, so screen resolution.
    size: [(640 * 72) / 96, (480 * 72) / 96],
    components: 3,
  },
  {
    name: 'codestream with a grid origin',
    // The image is the grid minus its origin, so Xsiz alone would be too big.
    bytes: codestream({ xsiz: 700, ysiz: 500, xo: 60, yo: 20 }),
    pixels: [640, 480],
    size: [(640 * 72) / 96, (480 * 72) / 96],
    components: 3,
  },
  {
    name: 'single-component codestream',
    bytes: codestream({ xsiz: 100, ysiz: 50, components: 1 }),
    pixels: [100, 50],
    size: [(100 * 72) / 96, (50 * 72) / 96],
    components: 1,
  },
  {
    name: 'jp2 wrapper, no resolution box',
    bytes: jp2({ xsiz: 320, ysiz: 240 }),
    pixels: [320, 240],
    size: [(320 * 72) / 96, (240 * 72) / 96],
    components: 3,
  },
  {
    name: 'jp2 wrapper at 254dpi',
    bytes: jp2({
      xsiz: 2000,
      ysiz: 3000,
      resolution: { vertical: ppm(254), horizontal: ppm(254) },
    }),
    pixels: [2000, 3000],
    size: [(2000 * 72) / 254, (3000 * 72) / 254],
    components: 3,
  },
  {
    name: 'jp2 wrapper with non-square resolution',
    // 254dpi across, 127 down. Swapping the two would give 576x72 instead of
    // 288x144, so this is the fixture that catches the order in the box.
    bytes: jp2({
      xsiz: 1016,
      ysiz: 254,
      resolution: { vertical: ppm(127), horizontal: ppm(254) },
    }),
    pixels: [1016, 254],
    size: [288, 144],
    components: 3,
  },
  {
    name: 'jp2 wrapper with only a display-grid box',
    bytes: jp2({
      xsiz: 1016,
      ysiz: 254,
      resolution: { vertical: ppm(127), horizontal: ppm(254) },
      resolutionType: 'resd',
    }),
    pixels: [1016, 254],
    size: [288, 144],
    components: 3,
  },
];

for (const item of cases) {
  const before = failures.length;
  group.push(checks);
  try {
    const result = jpeg2000ToPdf(new Uint8Array(item.bytes));

    check(`${item.name}: pixel width`, result.width === item.pixels[0], `got ${result.width}`);
    check(`${item.name}: pixel height`, result.height === item.pixels[1], `got ${result.height}`);
    check(
      `${item.name}: components`,
      result.components === item.components,
      `got ${result.components}`,
    );

    const pages = pagesOf(result.bytes);
    check(`${item.name}: one page`, pages.length === 1, `got ${pages.length}`);
    const [page] = pages;
    if (page) {
      close(`${item.name}: page width`, page.size[0], item.size[0]);
      close(`${item.name}: page height`, page.size[1], item.size[1]);

      const [image] = page.images;
      check(`${item.name}: one image`, page.images.length === 1);
      if (image) {
        check(`${item.name}: filter`, image.dict.includes('/Filter/JPXDecode'), image.dict);
        check(
          `${item.name}: width in the dictionary`,
          image.dict.includes(`/Width ${item.pixels[0]}`),
          image.dict,
        );
        check(
          `${item.name}: height in the dictionary`,
          image.dict.includes(`/Height ${item.pixels[1]}`),
          image.dict,
        );
        // Both are the codestream's to declare, and a copy here could only
        // contradict it.
        check(`${item.name}: no colour space`, !image.dict.includes('/ColorSpace'), image.dict);
        check(`${item.name}: no depth`, !image.dict.includes('/BitsPerComponent'), image.dict);

        const stream = Buffer.from(image.stream);
        check(
          `${item.name}: stream is the file that went in`,
          stream.length === item.bytes.length && stream.equals(Buffer.from(item.bytes)),
          `${stream.length} bytes, wanted ${item.bytes.length}`,
        );
      }
    }
  } catch (cause) {
    check(`${item.name}: converted`, false, `${cause.name}: ${cause.message}`);
  }
  report(item.name, before);
}

// --- and what must be refused -------------------------------------------

const before = failures.length;
group.push(checks);
for (const { name, bytes, because } of [
  {
    name: 'a wrapper with no codestream',
    bytes: Buffer.concat([
      Buffer.from([0x00, 0x00, 0x00, 0x0c, 0x6a, 0x50, 0x20, 0x20, 0x0d, 0x0a, 0x87, 0x0a]),
      box('ftyp', Buffer.concat([Buffer.from('jp2 '), u32(0), Buffer.from('jp2 ')])),
    ]),
    because: 'no size marker',
  },
  {
    name: 'an empty reference grid',
    bytes: codestream({ xsiz: 100, ysiz: 100, xo: 100, yo: 100 }),
    because: 'no size',
  },
  { name: 'something else entirely', bytes: Buffer.from('%PDF-1.7 hello'), because: 'not a JPEG 2000' },
]) {
  let message = null;
  try {
    jpeg2000ToPdf(new Uint8Array(bytes));
  } catch (cause) {
    message = cause.message;
  }
  check(
    `refuses ${name}`,
    message !== null && message.includes(because),
    message === null ? 'it was accepted' : `said "${message}"`,
  );
}
report('refusals', before);

if (failures.length > 0) {
  console.error(`${failures.length} of ${checks} checks failed`);
  process.exit(1);
}
console.log(`${checks} checks passed`);
