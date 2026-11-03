/**
 * The TIFFs the conversion suite reads, and what each one must become.
 *
 * Generated rather than committed, for the reason `make-pdf.mjs` is: a checked
 * in binary blob stops being the thing anyone reads, and nobody can tell what
 * it is supposed to contain. Here the bytes and the expectation are written
 * side by side, so a fixture cannot drift away from what it is testing.
 *
 * Every fixture carries the same pattern: a solid block filling exactly one
 * quadrant, white elsewhere. That one shape catches a family of bugs at once —
 * an inverted page is mostly ink, a vertically flipped page has the block in
 * the wrong half, a mirrored page has it in the wrong column, and a page whose
 * strips are assembled out of order scrambles it. A uniform grey square would
 * catch none of them.
 *
 * The CCITT streams are coded by hand from the T.4 run-length tables, which is
 * less fragile than it sounds: a single wrong code word decodes to a different
 * run length, so the block lands somewhere else or the row desynchronises and
 * the test fails. The suite checks the pass-through streams byte for byte
 * against what went in, so the fax codings are verified as *transport* here;
 * that they also decode to the right picture is checked by rendering them
 * through PDF.js, which is an independent implementation of the same tables.
 *
 *   node make-tiffs.mjs <out dir>
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import path from 'node:path';

const W = 64;
const H = 32;

// --- the test pattern ---------------------------------------------------

/** `1` where there is ink. `quadrant` is one of tl, tr, bl, br. */
export function pattern(quadrant, width = W, height = H) {
  const left = quadrant[1] === 'l';
  const top = quadrant[0] === 't';
  const rows = [];
  for (let y = 0; y < height; y++) {
    const row = new Uint8Array(width);
    if (top ? y < height / 2 : y >= height / 2) {
      const from = left ? 0 : width / 2;
      row.fill(1, from, from + width / 2);
    }
    rows.push(row);
  }
  return rows;
}

/** 1 bit a pixel, WhiteIsZero: an ink pixel is a 1. */
export function packBilevel(rows) {
  const stride = Math.ceil(rows[0].length / 8);
  const out = Buffer.alloc(stride * rows.length);
  rows.forEach((row, y) => {
    row.forEach((pixel, x) => {
      if (pixel) out[y * stride + (x >> 3)] |= 0x80 >> (x & 7);
    });
  });
  return out;
}

/** 8 bits a pixel, BlackIsZero: ink is 0. */
export function packGray(rows) {
  const width = rows[0].length;
  const out = Buffer.alloc(width * rows.length);
  rows.forEach((row, y) => {
    row.forEach((pixel, x) => {
      out[y * width + x] = pixel ? 0 : 255;
    });
  });
  return out;
}

/** Ink is pure red, so a swapped channel shows up as a blue block. */
export function packRgb(rows) {
  const width = rows[0].length;
  const out = Buffer.alloc(width * rows.length * 3);
  rows.forEach((row, y) => {
    row.forEach((pixel, x) => {
      const at = (y * width + x) * 3;
      out[at] = 255;
      out[at + 1] = pixel ? 0 : 255;
      out[at + 2] = pixel ? 0 : 255;
    });
  });
  return out;
}

/** The same with an alpha channel, which conversion has to drop. */
function packRgba(rows) {
  const width = rows[0].length;
  const out = Buffer.alloc(width * rows.length * 4);
  rows.forEach((row, y) => {
    row.forEach((pixel, x) => {
      const at = (y * width + x) * 4;
      out[at] = 255;
      out[at + 1] = pixel ? 0 : 255;
      out[at + 2] = pixel ? 0 : 255;
      out[at + 3] = 255;
    });
  });
  return out;
}

// --- bit writing and the fax codings ------------------------------------

class Bits {
  constructor() {
    this.bytes = [];
    this.current = 0;
    this.filled = 0;
  }
  push(code) {
    for (const character of code) {
      this.current = (this.current << 1) | (character === '1' ? 1 : 0);
      if (++this.filled === 8) {
        this.bytes.push(this.current);
        this.current = 0;
        this.filled = 0;
      }
    }
  }
  align() {
    while (this.filled !== 0) this.push('0');
  }
  done() {
    this.align();
    return Buffer.from(this.bytes);
  }
}

// T.4 codes, only the run lengths these fixtures use.
const WHITE = { 0: '00110101', 32: '00011011' };
const BLACK = { 0: '0000110111', 32: '000001101010' };
const WHITE_MAKEUP = { 64: '11011', 832: '011010010', 1728: '010011011' };
const BLACK_MAKEUP = { 64: '0000001111', 832: '0000001001101' };

/**
 * A run as 1D codes: a make-up code for the whole multiple of 64, then a
 * terminating code for the remainder. A run under 64 is a single code.
 */
function runCode(colour, length) {
  const terminating = colour === 'white' ? WHITE : BLACK;
  const code = (table, key) => {
    const found = table[key];
    if (found === undefined) throw new Error(`no ${colour} code for ${key}`);
    return found;
  };
  if (length < 64) return code(terminating, length);
  const whole = Math.min(Math.floor(length / 64) * 64, 1728);
  return (
    code(colour === 'white' ? WHITE_MAKEUP : BLACK_MAKEUP, whole) +
    code(terminating, length - whole)
  );
}

/** A row's runs, starting with white — zero-length if the row starts black. */
function runsOf(row) {
  const runs = [];
  let colour = 0;
  let length = 0;
  for (const pixel of row) {
    if (pixel === colour) {
      length++;
    } else {
      runs.push(length);
      colour = pixel;
      length = 1;
    }
  }
  runs.push(length);
  return runs;
}

/** Group 4, coded entirely in horizontal mode, which is always legal. */
function encodeG4(rows) {
  const bits = new Bits();
  for (const row of rows) {
    const runs = runsOf(row);
    // Horizontal mode codes two runs at a time, so pad to an even count.
    if (runs.length % 2 === 1) runs.push(0);
    for (let i = 0; i < runs.length; i += 2) {
      bits.push('001');
      bits.push(runCode('white', runs[i]));
      bits.push(runCode('black', runs[i + 1]));
    }
  }
  bits.push('000000000001000000000001'); // end of facsimile block
  return bits.done();
}

/** Compression 2: the same codes, no mode prefix, each row byte-aligned. */
function encodeCcittRle(rows) {
  const bits = new Bits();
  for (const row of rows) {
    let colour = 'white';
    for (const run of runsOf(row)) {
      bits.push(runCode(colour, run));
      colour = colour === 'white' ? 'black' : 'white';
    }
    bits.align();
  }
  return bits.done();
}

/** Horizontal differencing, as TIFF's predictor 2 stores it. */
function applyPredictor(raster, width, height, samples) {
  const stride = width * samples;
  const out = Buffer.from(raster);
  for (let y = 0; y < height; y++) {
    for (let i = stride - 1; i >= samples; i--) {
      out[y * stride + i] = (out[y * stride + i] - out[y * stride + i - samples]) & 0xff;
    }
  }
  return out;
}

function encodePackBits(raster, width, height, samples) {
  const stride = width * samples;
  const parts = [];
  for (let y = 0; y < height; y++) {
    const row = raster.subarray(y * stride, (y + 1) * stride);
    let at = 0;
    while (at < row.length) {
      let run = 1;
      while (run < 128 && at + run < row.length && row[at + run] === row[at]) run++;
      if (run >= 2) {
        parts.push(Buffer.from([257 - run, row[at]]));
        at += run;
      } else {
        let literal = 1;
        while (
          literal < 128 &&
          at + literal < row.length &&
          !(at + literal + 1 < row.length && row[at + literal + 1] === row[at + literal])
        ) {
          literal++;
        }
        parts.push(Buffer.from([literal - 1]), Buffer.from(row.subarray(at, at + literal)));
        at += literal;
      }
    }
  }
  return Buffer.concat(parts);
}

/**
 * LZW as TIFF packs it: codes high bit first, nine bits wide.
 *
 * Only literal codes, with a Clear before the table could grow wide enough to
 * change the code width. A valid if unambitious stream — the point is to
 * exercise the decoder, not to compress.
 */
function encodeLzw(raster) {
  const bits = new Bits();
  const nine = (code) => bits.push(code.toString(2).padStart(9, '0'));
  nine(256);
  let since = 0;
  for (const byte of raster) {
    if (since >= 240) {
      nine(256);
      since = 0;
    }
    nine(byte);
    since++;
  }
  nine(257);
  return bits.done();
}

// --- the TIFF container -------------------------------------------------

const SHORT = 3;
const LONG = 4;
const RATIONAL = 5;
const SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8 };

/**
 * A TIFF of one or more pages.
 *
 * Strip data first, then each page's out-of-line tag values and its directory,
 * chained by the next-IFD pointer. Tags are written in ascending order, which
 * TIFF requires and nothing enforces.
 */
function tiff(pages, { little = true } = {}) {
  const parts = [];
  let at = 0;
  const append = (buffer) => {
    parts.push(buffer);
    const offset = at;
    at += buffer.length;
    return offset;
  };

  const u16 = (value) => {
    const b = Buffer.alloc(2);
    if (little) b.writeUInt16LE(value);
    else b.writeUInt16BE(value);
    return b;
  };
  const u32 = (value) => {
    const b = Buffer.alloc(4);
    if (little) b.writeUInt32LE(value);
    else b.writeUInt32BE(value);
    return b;
  };

  append(Buffer.concat([Buffer.from(little ? 'II' : 'MM'), u16(42), u32(0)]));

  const stripOffsets = pages.map((page) =>
    page.strips.map((strip) => append(Buffer.from(strip))),
  );
  if (at % 2 === 1) append(Buffer.alloc(1));

  const ifdAt = [];
  pages.forEach((page, index) => {
    const tags = new Map(page.tags);
    tags.set(273, { type: LONG, values: stripOffsets[index] });
    tags.set(279, { type: LONG, values: page.strips.map((strip) => strip.length) });

    const external = new Map();
    for (const [tag, { type, values }] of tags) {
      if (SIZE[type] * values.length > 4) {
        external.set(
          tag,
          append(
            Buffer.concat(
              values.map((value) =>
                type === RATIONAL
                  ? Buffer.concat([u32(Math.round(value * 10000)), u32(10000)])
                  : type === SHORT
                    ? u16(value)
                    : u32(value),
              ),
            ),
          ),
        );
        if (at % 2 === 1) append(Buffer.alloc(1));
      }
    }

    const ordered = [...tags.entries()].sort((a, b) => a[0] - b[0]);
    const entries = ordered.map(([tag, { type, values }]) => {
      const inline = Buffer.alloc(4);
      if (external.has(tag)) {
        u32(external.get(tag)).copy(inline);
      } else if (type === SHORT) {
        values.forEach((value, i) => u16(value).copy(inline, i * 2));
      } else {
        values.forEach((value, i) => u32(value).copy(inline, i * 4));
      }
      return Buffer.concat([u16(tag), u16(type), u32(values.length), inline]);
    });

    ifdAt.push(append(Buffer.concat([u16(ordered.length), ...entries, u32(0)])));
  });

  const file = Buffer.concat(parts);
  const put = (value, offset) =>
    little ? file.writeUInt32LE(value, offset) : file.writeUInt32BE(value, offset);
  put(ifdAt[0], 4);
  ifdAt.forEach((offset, index) => {
    const count = little ? file.readUInt16LE(offset) : file.readUInt16BE(offset);
    put(index + 1 < ifdAt.length ? ifdAt[index + 1] : 0, offset + 2 + count * 12);
  });
  return file;
}

/** The tags every page needs. */
function page({
  width = W,
  height = H,
  compression,
  photometric,
  bits = [1],
  samples = 1,
  xDpi = 96,
  yDpi = 96,
  rowsPerStrip = height,
  strips,
  extra = {},
}) {
  const tags = new Map([
    [256, { type: LONG, values: [width] }],
    [257, { type: LONG, values: [height] }],
    [258, { type: SHORT, values: bits }],
    [259, { type: SHORT, values: [compression] }],
    [262, { type: SHORT, values: [photometric] }],
    [277, { type: SHORT, values: [samples] }],
    [278, { type: LONG, values: [rowsPerStrip] }],
    [282, { type: RATIONAL, values: [xDpi] }],
    [283, { type: RATIONAL, values: [yDpi] }],
    [284, { type: SHORT, values: [1] }],
    [296, { type: SHORT, values: [2] }],
  ]);
  for (const [tag, value] of Object.entries(extra)) tags.set(Number(tag), value);
  return { tags, strips };
}

/** Rows split into strips of `perStrip` each, encoded one strip at a time. */
function split(rows, perStrip, encode) {
  const strips = [];
  for (let at = 0; at < rows.length; at += perStrip) {
    strips.push(encode(rows.slice(at, at + perStrip)));
  }
  return strips;
}

/** Points for a run of pixels, as a PDF page box measures them. */
const pt = (pixels, dpi) => (pixels * 72) / dpi;

// --- the fixtures -------------------------------------------------------

/**
 * Each fixture is its bytes and what conversion must produce.
 *
 * `stream` is an exact expected byte string, which is the whole claim of the
 * pass-through path: the PDF carries the scan's own data, untouched. `samples`
 * is the expected raster for a page that had to be decoded, compared sample by
 * sample after the Deflate is undone.
 */
export function fixtures() {
  const tl = pattern('tl');
  const g4 = encodeG4(tl);
  const letter = [pt(64, 96), pt(32, 96)];

  const list = [];
  const add = (name, bytes, pages) => list.push({ name, bytes, pages });

  add('g4.tif', tiff([page({ compression: 4, photometric: 0, strips: [g4] })]), [
    {
      size: letter,
      images: [
        {
          filter: 'CCITTFaxDecode',
          space: '/DeviceGray',
          bits: 1,
          parms: ['/K -1', '/Columns 64', '/Rows 32'],
          notParms: ['/BlackIs1'],
          stream: g4,
        },
      ],
    },
  ]);

  const blank = encodeG4(pattern('tl').map((row) => row.fill(0)));
  add('g4-blank.tif', tiff([page({ compression: 4, photometric: 0, strips: [blank] })]), [
    { size: letter, images: [{ filter: 'CCITTFaxDecode', bits: 1, stream: blank }] },
  ]);

  // Four strips, each an independent Group 4 stream, stacked down the page.
  const banded = split(tl, 8, encodeG4);
  add(
    'g4-strips.tif',
    tiff([page({ compression: 4, photometric: 0, rowsPerStrip: 8, strips: banded })]),
    [
      {
        size: letter,
        images: banded.map((strip, index) => ({
          filter: 'CCITTFaxDecode',
          bits: 1,
          parms: ['/Rows 8'],
          stream: strip,
          // Row 0 is the top of the page, and the page box counts from the
          // bottom, so the first strip is the highest.
          at: [0, pt(32 - 8 * (index + 1), 96), pt(64, 96), pt(8, 96)],
        })),
      },
    ],
  );

  // The same page with every byte's bits the other way round, which PDF has
  // no way to describe and so must be turned round during conversion.
  const reversed = Buffer.from(
    [...g4].map((byte) =>
      Number.parseInt([...byte.toString(2).padStart(8, '0')].reverse().join(''), 2),
    ),
  );
  add(
    'g4-lsb.tif',
    tiff([
      page({
        compression: 4,
        photometric: 0,
        strips: [reversed],
        extra: { 266: { type: SHORT, values: [2] } },
      }),
    ]),
    [{ size: letter, images: [{ filter: 'CCITTFaxDecode', bits: 1, stream: g4 }] }],
  );

  const rle = encodeCcittRle(tl);
  add('ccitt-rle.tif', tiff([page({ compression: 2, photometric: 0, strips: [rle] })]), [
    {
      size: letter,
      images: [
        {
          filter: 'CCITTFaxDecode',
          bits: 1,
          parms: ['/K 0', '/EncodedByteAlign true'],
          stream: rle,
        },
      ],
    },
  ]);

  // A page that declares BlackIsZero means its fax inverted, which is the one
  // case where the flag has to be set.
  add('g4-inverted.tif', tiff([page({ compression: 4, photometric: 1, strips: [g4] })]), [
    {
      size: letter,
      images: [{ filter: 'CCITTFaxDecode', bits: 1, parms: ['/BlackIs1 true'], stream: g4 }],
    },
  ]);

  const bilevel = packBilevel(tl);
  for (const [name, little] of [
    ['raw-le.tif', true],
    ['raw-be.tif', false],
  ]) {
    add(
      name,
      tiff([page({ compression: 1, photometric: 0, strips: [bilevel] })], { little }),
      [
        {
          size: letter,
          images: [
            { filter: 'FlateDecode', space: '/DeviceGray', bits: 1, decode: '[1 0]', samples: bilevel },
          ],
        },
      ],
    );
  }

  const gray = packGray(tl);
  add(
    'gray.tif',
    tiff([page({ compression: 1, photometric: 1, bits: [8], strips: [gray] })]),
    [{ size: letter, images: [{ filter: 'FlateDecode', space: '/DeviceGray', bits: 8, samples: gray }] }],
  );

  add(
    'packbits.tif',
    tiff([
      page({
        compression: 32773,
        photometric: 1,
        bits: [8],
        strips: [encodePackBits(gray, W, H, 1)],
      }),
    ]),
    [{ size: letter, images: [{ filter: 'FlateDecode', bits: 8, samples: gray }] }],
  );

  const rgb = packRgb(tl);
  add(
    'lzw-rgb.tif',
    tiff([
      page({
        compression: 5,
        photometric: 2,
        bits: [8, 8, 8],
        samples: 3,
        rowsPerStrip: 4,
        strips: split(tl, 4, (rows) => encodeLzw(packRgb(rows))),
      }),
    ]),
    [{ size: letter, images: [{ filter: 'FlateDecode', space: '/DeviceRGB', bits: 8, samples: rgb }] }],
  );

  add(
    'deflate-predictor.tif',
    tiff([
      page({
        compression: 8,
        photometric: 2,
        bits: [8, 8, 8],
        samples: 3,
        rowsPerStrip: 8,
        strips: split(tl, 8, (rows) =>
          deflateSync(applyPredictor(packRgb(rows), W, rows.length, 3)),
        ),
        extra: { 317: { type: SHORT, values: [2] } },
      }),
    ]),
    [{ size: letter, images: [{ filter: 'FlateDecode', space: '/DeviceRGB', bits: 8, samples: rgb }] }],
  );

  add(
    'rgba.tif',
    tiff([
      page({
        compression: 1,
        photometric: 2,
        bits: [8, 8, 8, 8],
        samples: 4,
        strips: [packRgba(tl)],
        extra: { 338: { type: SHORT, values: [2] } },
      }),
    ]),
    [{ size: letter, images: [{ filter: 'FlateDecode', space: '/DeviceRGB', bits: 8, samples: rgb }] }],
  );

  add(
    'palette.tif',
    tiff([
      page({
        compression: 1,
        photometric: 3,
        bits: [8],
        strips: [Buffer.from(tl.flatMap((row) => [...row]))],
        extra: {
          320: {
            type: SHORT,
            // 256 reds, then greens, then blues: entry 0 white, entry 1 red.
            values: [
              0xffff, 0xffff, ...Array(254).fill(0),
              0xffff, 0, ...Array(254).fill(0),
              0xffff, 0, ...Array(254).fill(0),
            ],
          },
        },
      }),
    ]),
    [{ size: letter, images: [{ filter: 'FlateDecode', space: '/DeviceRGB', bits: 8, samples: rgb }] }],
  );

  // A real fax: the standard 1728-pixel scan line at the standard asymmetric
  // fax resolution, which is where a page laid out as though its pixels were
  // square comes out a third too tall.
  const fax = encodeG4(pattern('tl', 1728, 1143));
  add(
    'fax-g4.tif',
    tiff([
      page({
        width: 1728,
        height: 1143,
        compression: 4,
        photometric: 0,
        xDpi: 204,
        yDpi: 196,
        strips: [fax],
      }),
    ]),
    [
      {
        size: [pt(1728, 204), pt(1143, 196)],
        images: [{ filter: 'CCITTFaxDecode', bits: 1, parms: ['/Columns 1728'], stream: fax }],
      },
    ],
  );

  // Three pages, each a different coding, a different quadrant and a different
  // resolution.
  const tr = pattern('tr');
  const bl = pattern('bl');
  add(
    'multipage.tif',
    tiff([
      page({ compression: 4, photometric: 0, strips: [g4] }),
      page({
        compression: 1,
        photometric: 0,
        xDpi: 204,
        yDpi: 196,
        strips: [packBilevel(tr)],
      }),
      page({
        compression: 8,
        photometric: 2,
        bits: [8, 8, 8],
        samples: 3,
        xDpi: 300,
        yDpi: 300,
        strips: [deflateSync(packRgb(bl))],
      }),
    ]),
    [
      { size: letter, images: [{ filter: 'CCITTFaxDecode', bits: 1, stream: g4 }] },
      {
        size: [pt(64, 204), pt(32, 196)],
        images: [{ filter: 'FlateDecode', bits: 1, decode: '[1 0]', samples: packBilevel(tr) }],
      },
      {
        size: [pt(64, 300), pt(32, 300)],
        images: [{ filter: 'FlateDecode', bits: 8, samples: packRgb(bl) }],
      },
    ],
  );

  return list;
}

/** TIFFs that must be refused, with the reason that must be given. */
export function refusals() {
  const tl = pattern('tl');
  return [
    {
      name: 'tiled',
      bytes: tiff([
        page({
          compression: 1,
          photometric: 0,
          strips: [packBilevel(tl)],
          extra: { 322: { type: LONG, values: [32] } },
        }),
      ]),
      because: 'tiled',
    },
    {
      name: 'old-style JPEG',
      bytes: tiff([page({ compression: 6, photometric: 2, strips: [Buffer.alloc(8)] })]),
      because: 'old-style JPEG',
    },
    {
      name: 'separate planes',
      bytes: tiff([
        page({
          compression: 1,
          photometric: 2,
          bits: [8, 8, 8],
          samples: 3,
          strips: [Buffer.alloc(64)],
          extra: { 284: { type: SHORT, values: [2] } },
        }),
      ]),
      because: 'separate planes',
    },
    {
      name: 'BigTIFF',
      bytes: Buffer.concat([Buffer.from('II'), Buffer.from([43, 0, 8, 0, 0, 0, 0, 0])]),
      because: 'BigTIFF',
    },
    { name: 'not a TIFF', bytes: Buffer.from('%PDF-1.7 and then some'), because: 'not a TIFF' },
  ];
}

/**
 * A 300dpi colour page of letter size: the heavy end of the decoding path, at
 * 25MB of samples before compression. Built on request rather than with the
 * rest, because holding it costs more than every other fixture together.
 */
export function bigPage() {
  const rows = pattern('tl', 2550, 3300);
  return {
    name: 'big-deflate-rgb.tif',
    bytes: tiff([
      page({
        width: 2550,
        height: 3300,
        compression: 8,
        photometric: 2,
        bits: [8, 8, 8],
        samples: 3,
        xDpi: 300,
        yDpi: 300,
        rowsPerStrip: 64,
        strips: split(rows, 64, (band) => deflateSync(packRgb(band))),
      }),
    ]),
    size: [612, 792],
    samples: packRgb(rows),
  };
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))) {
  const out = process.argv[2];
  if (!out) {
    console.error('usage: node make-tiffs.mjs <out dir>');
    process.exit(2);
  }
  mkdirSync(out, { recursive: true });
  for (const { name, bytes } of fixtures()) {
    writeFileSync(path.join(out, name), bytes);
  }
  const big = bigPage();
  writeFileSync(path.join(out, big.name), big.bytes);
  console.log(`wrote ${fixtures().length + 1} TIFFs to ${out}`);
}
