/**
 * TIFF, opened as PDF.
 *
 * TIFF is the format an ECM cannot do without and a browser cannot read: it is
 * what scanners and fax servers write, it is the only common image format that
 * holds many pages, and no browser has ever decoded it. Until now it was the
 * one gap in `to-pdf.ts` — every other raster format reached the PDF viewer
 * and this one sat behind "needs a decoder".
 *
 * It mostly does not need a decoder. A TIFF is a container, and what it
 * contains is usually already a PDF image filter:
 *
 *   - a scanned page is CCITT Group 3 or Group 4, which is PDF's CCITTFaxDecode
 *   - a photographic page is JPEG, which is PDF's DCTDecode
 *
 * So for the two formats that matter most the conversion moves bytes and
 * writes a dictionary. Nothing is decoded, nothing is re-encoded, and a 300dpi
 * Group 4 page stays the 40kB it was — where decoding it to pixels and
 * re-encoding as JPEG would have cost a megabyte, a generation of quality, and
 * the crisp edges that make scanned text readable at all.
 *
 * The rest — uncompressed, PackBits, LZW, Deflate — is decoded here and
 * re-compressed with Deflate, which is lossless. Only three things are
 * refused: old-style JPEG (compression 6, withdrawn by its own authors),
 * tiled TIFFs, which are a mapping format rather than a document one, and
 * BigTIFF.
 *
 * Multi-page is the point of all this. A three-page fax becomes a three-page
 * PDF, each page the size its own resolution implies — fax resolution is
 * famously not square (204x196), and a page laid out as though it were comes
 * out visibly stretched.
 */

import {
  imageDocument,
  pointsFor,
  type ImageFilter,
  type ImagePage,
  type PlacedImage,
} from './pdf-document';

/** When a file declares no resolution, assume its pixels are screen pixels. */
const DEFAULT_DPI = 96;

/**
 * A page assembled from more than this many strips is refused rather than
 * written as a stack of that many image objects. Only the pass-through filters
 * can reach it — a strip of CCITT or JPEG is its own stream and cannot be
 * joined to the next — and a scan written that way is pathological: a scanner
 * that writes Group 4 writes one strip a page.
 */
const MAX_STRIPS = 256;

export interface TiffConversion {
  bytes: Uint8Array;
  pages: number;
  /** True when no page had to be decoded, for the note the viewer shows. */
  passedThrough: boolean;
}

/**
 * A TIFF this converter will not open.
 *
 * The message is a sentence fragment beginning "it", because the viewer shows
 * it after "This document could not be opened:" — a message that repeats the
 * frame it is shown in reads like a stutter.
 */
export class TiffUnsupported extends Error {
  constructor(what: string) {
    super(`${what}.`);
    this.name = 'TiffUnsupported';
  }
}

/** TIFF's own names for how a page's samples are packed. */
const Compression = {
  none: 1,
  ccittRle: 2,
  ccittG3: 3,
  ccittG4: 4,
  lzw: 5,
  jpegOld: 6,
  jpeg: 7,
  deflate: 8,
  packBits: 32773,
  deflateOld: 32946,
} as const;

/** What the page's samples mean. */
const Photometric = {
  whiteIsZero: 0,
  blackIsZero: 1,
  rgb: 2,
  palette: 3,
  cmyk: 5,
} as const;

const Tag = {
  imageWidth: 256,
  imageLength: 257,
  bitsPerSample: 258,
  compression: 259,
  photometric: 262,
  fillOrder: 266,
  stripOffsets: 273,
  samplesPerPixel: 277,
  rowsPerStrip: 278,
  stripByteCounts: 279,
  xResolution: 282,
  yResolution: 283,
  planarConfig: 284,
  t4Options: 292,
  resolutionUnit: 296,
  predictor: 317,
  colorMap: 320,
  tileWidth: 322,
} as const;

export function isTiff(bytes: Uint8Array): boolean {
  if (bytes.length < 8) return false;
  const little = bytes[0] === 0x49 && bytes[1] === 0x49;
  const big = bytes[0] === 0x4d && bytes[1] === 0x4d;
  if (!little && !big) return false;
  const version = little ? bytes[2]! | (bytes[3]! << 8) : (bytes[2]! << 8) | bytes[3]!;
  return version === 42 || version === 43;
}

/** Every page of a TIFF, as one PDF. */
export async function tiffToPdf(bytes: Uint8Array): Promise<TiffConversion> {
  const file = new TiffFile(bytes);
  const directories = file.directories();
  if (directories.length === 0) throw new TiffUnsupported('it holds no pages');

  const pages: ImagePage[] = [];
  let passedThrough = true;
  for (const ifd of directories) {
    const result = await pageOf(file, ifd);
    if (!result.passedThrough) passedThrough = false;
    pages.push(result.page);
  }

  return { bytes: imageDocument(pages), pages: pages.length, passedThrough };
}

// --- the file -----------------------------------------------------------

type Ifd = Map<number, { type: number; count: number; offset: number }>;

const TYPE_SIZE: Record<number, number> = {
  1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8,
};

class TiffFile {
  readonly bytes: Uint8Array;
  readonly view: DataView;
  readonly little: boolean;

  // Spelled out rather than declared as a constructor parameter property, so
  // that this module runs under Node's type stripping and can be tested
  // without a bundler. See tests/tiff.mjs.
  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
    if (!isTiff(bytes)) throw new TiffUnsupported('it is not a TIFF');
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.little = bytes[0] === 0x49;
    if (this.u16(2) === 43) {
      // BigTIFF moves to 64-bit offsets and an incompatible header. Nothing a
      // scanner writes needs it, and a refusal beats a misread.
      throw new TiffUnsupported('BigTIFF is not supported');
    }
  }

  u16(at: number): number {
    return this.view.getUint16(at, this.little);
  }

  u32(at: number): number {
    return this.view.getUint32(at, this.little);
  }

  /** The chain of image file directories: one per page, in file order. */
  directories(): Ifd[] {
    const out: Ifd[] = [];
    const seen = new Set<number>();
    let at = this.u32(4);

    while (at !== 0 && at + 2 <= this.bytes.length) {
      // A malformed file can point an IFD at itself, and a page count is not
      // worth a hang.
      if (seen.has(at) || out.length > 10_000) break;
      seen.add(at);

      const count = this.u16(at);
      const ifd: Ifd = new Map();
      for (let i = 0; i < count; i++) {
        const entry = at + 2 + i * 12;
        if (entry + 12 > this.bytes.length) break;
        ifd.set(this.u16(entry), {
          type: this.u16(entry + 2),
          count: this.u32(entry + 4),
          offset: entry + 8,
        });
      }
      out.push(ifd);
      const after = at + 2 + count * 12;
      at = after + 4 <= this.bytes.length ? this.u32(after) : 0;
    }
    return out;
  }

  /**
   * A tag's values.
   *
   * A tag whose values fit in four bytes stores them in the entry itself
   * rather than at an offset, which is the one piece of TIFF that catches
   * everybody: reading that field as a pointer gives a plausible-looking
   * number that is really two shorts.
   */
  values(ifd: Ifd, tag: number): number[] {
    const entry = ifd.get(tag);
    if (!entry) return [];
    const size = TYPE_SIZE[entry.type];
    if (!size) return [];

    const total = size * entry.count;
    const base = total <= 4 ? entry.offset : this.u32(entry.offset);
    if (base + total > this.bytes.length) return [];

    const out: number[] = [];
    for (let i = 0; i < entry.count; i++) {
      const at = base + i * size;
      switch (entry.type) {
        case 1: case 2: case 7: out.push(this.bytes[at]!); break;
        case 6: out.push(this.view.getInt8(at)); break;
        case 3: out.push(this.u16(at)); break;
        case 8: out.push(this.view.getInt16(at, this.little)); break;
        case 4: out.push(this.u32(at)); break;
        case 9: out.push(this.view.getInt32(at, this.little)); break;
        case 5: {
          const d = this.u32(at + 4);
          out.push(d === 0 ? 0 : this.u32(at) / d);
          break;
        }
        case 10: {
          const d = this.view.getInt32(at + 4, this.little);
          out.push(d === 0 ? 0 : this.view.getInt32(at, this.little) / d);
          break;
        }
        case 11: out.push(this.view.getFloat32(at, this.little)); break;
        case 12: out.push(this.view.getFloat64(at, this.little)); break;
        default: return [];
      }
    }
    return out;
  }

  value(ifd: Ifd, tag: number, fallback: number): number {
    const values = this.values(ifd, tag);
    return values.length > 0 ? values[0]! : fallback;
  }
}

// --- one page -----------------------------------------------------------

interface Geometry {
  width: number;
  height: number;
  pageWidth: number;
  pageHeight: number;
  xDpi: number;
  yDpi: number;
}

interface Layout extends Geometry {
  compression: number;
  photometric: number;
  bitsPerSample: number;
  samples: number;
  strips: Strip[];
}

async function pageOf(
  file: TiffFile,
  ifd: Ifd,
): Promise<{ page: ImagePage; passedThrough: boolean }> {
  if (ifd.has(Tag.tileWidth)) {
    throw new TiffUnsupported('it is tiled rather than stripped');
  }

  const width = file.value(ifd, Tag.imageWidth, 0);
  const height = file.value(ifd, Tag.imageLength, 0);
  if (width <= 0 || height <= 0) throw new TiffUnsupported('a page declares no size');

  const compression = file.value(ifd, Tag.compression, Compression.none);
  if (compression === Compression.jpegOld) {
    throw new TiffUnsupported('it uses old-style JPEG, withdrawn in 1995');
  }
  if (file.value(ifd, Tag.planarConfig, 1) !== 1) {
    throw new TiffUnsupported('its channels are stored in separate planes');
  }

  const bits = file.values(ifd, Tag.bitsPerSample);
  if (bits.length > 1 && bits.some((b) => b !== bits[0])) {
    throw new TiffUnsupported('its channels have different depths');
  }

  const { xDpi, yDpi } = resolutionOf(file, ifd);
  const layout: Layout = {
    width,
    height,
    pageWidth: pointsFor(width, xDpi),
    pageHeight: pointsFor(height, yDpi),
    xDpi,
    yDpi,
    compression,
    photometric: file.value(ifd, Tag.photometric, Photometric.blackIsZero),
    bitsPerSample: bits.length > 0 ? bits[0]! : 1,
    samples: file.value(ifd, Tag.samplesPerPixel, 1),
    strips: stripsOf(file, ifd, height),
  };

  const filter = passThroughFilter(compression);
  const images = filter
    ? passThrough(file, ifd, layout, filter)
    : [await decodeToFlate(file, ifd, layout)];

  return {
    page: { width: layout.pageWidth, height: layout.pageHeight, images },
    passedThrough: filter !== null,
  };
}

function resolutionOf(file: TiffFile, ifd: Ifd): { xDpi: number; yDpi: number } {
  const unit = file.value(ifd, Tag.resolutionUnit, 2);
  const x = file.value(ifd, Tag.xResolution, 0);
  const y = file.value(ifd, Tag.yResolution, 0);

  // Unit 1 means the numbers are an aspect ratio with no absolute scale, so
  // there is no resolution to read — only a shape, which a square default
  // preserves for the overwhelmingly common case of x === y.
  const perInch = unit === 3 ? 2.54 : unit === 2 ? 1 : 0;
  return {
    xDpi: perInch && x > 0 ? x * perInch : DEFAULT_DPI,
    yDpi: perInch && y > 0 ? y * perInch : DEFAULT_DPI,
  };
}

interface Strip {
  offset: number;
  length: number;
  /** The first row of the page this strip holds. */
  firstRow: number;
  rows: number;
}

function stripsOf(file: TiffFile, ifd: Ifd, height: number): Strip[] {
  const offsets = file.values(ifd, Tag.stripOffsets);
  const counts = file.values(ifd, Tag.stripByteCounts);
  if (offsets.length === 0) throw new TiffUnsupported('a page holds no image data');

  // A missing RowsPerStrip means the whole page is one strip, which is what
  // its default of 2^32-1 says the long way round.
  const perStrip = Math.min(file.value(ifd, Tag.rowsPerStrip, height) || height, height);

  const strips = offsets.map((offset, i) => {
    const firstRow = i * perStrip;
    return {
      offset,
      length: counts[i] ?? 0,
      firstRow,
      rows: Math.max(0, Math.min(perStrip, height - firstRow)),
    };
  });
  const usable = strips.filter((strip) => strip.rows > 0 && strip.length > 0);
  if (usable.length === 0) throw new TiffUnsupported('a page holds no image data');
  return usable;
}

function passThroughFilter(compression: number): ImageFilter | null {
  switch (compression) {
    case Compression.ccittRle:
    case Compression.ccittG3:
    case Compression.ccittG4:
      return 'CCITTFaxDecode';
    case Compression.jpeg:
      return 'DCTDecode';
    default:
      // Deflate and LZW could pass through too, with a /DecodeParms predictor
      // to match. They are decoded instead, because both store one stream per
      // strip: a page of many strips would become a page of many image
      // objects for no gain, where decoding joins them into one. Deflate in,
      // Deflate out, so nothing is lost either way.
      return null;
  }
}

// --- the pass-through path ----------------------------------------------

/**
 * The strips, placed on the page with their encoding intact.
 *
 * One image object per strip, because a strip of CCITT or JPEG is a complete
 * stream in its own right: a Group 4 strip starts from an imaginary white row
 * above it, so two of them concatenated decode to noise. Stacking them is
 * exact instead — they tile the page without overlapping, which is what a
 * strip is.
 */
function passThrough(
  file: TiffFile,
  ifd: Ifd,
  layout: Layout,
  filter: ImageFilter,
): PlacedImage[] {
  if (layout.strips.length > MAX_STRIPS) {
    throw new TiffUnsupported(`it is split into ${layout.strips.length} strips`);
  }

  const ccitt = filter === 'CCITTFaxDecode';
  const lsbFirst = file.value(ifd, Tag.fillOrder, 1) === 2;
  const space = ccitt ? '/DeviceGray' : jpegColorSpace(file, layout);

  return layout.strips.map((strip) => {
    let bytes = file.bytes.subarray(strip.offset, strip.offset + strip.length);

    // PDF has no way to say "the low bit comes first", so a file that says so
    // has its bits turned round here instead.
    if (lsbFirst && ccitt) bytes = reverseBits(bytes);

    const common = {
      bytes,
      pixelWidth: layout.width,
      pixelHeight: strip.rows,
      filter,
      colorSpace: space,
      at: placeStrip(strip, layout),
    };

    return ccitt
      ? {
          ...common,
          bitsPerComponent: 1,
          decodeParms: ccittParms(file, ifd, layout, strip.rows),
        }
      : { ...common, bitsPerComponent: 8 };
  });
}

/** Where a strip sits on the page, in points from the bottom-left. */
function placeStrip(strip: Strip, layout: Layout) {
  const below = pointsFor(strip.firstRow + strip.rows, layout.yDpi);
  return {
    x: 0,
    y: layout.pageHeight - below,
    width: layout.pageWidth,
    height: pointsFor(strip.rows, layout.yDpi),
  };
}

/**
 * CCITTFaxDecode's parameters, which state the same facts as TIFF's own tags:
 * K is which of the three fax codings this is, and BlackIs1 is which way round
 * a bit means ink.
 *
 * BlackIs1 follows PhotometricInterpretation. A fax is WhiteIsZero, and PDF's
 * default already renders that correctly, so the flag is set only for the rare
 * file that declares BlackIsZero and therefore means its image inverted.
 */
function ccittParms(file: TiffFile, ifd: Ifd, layout: Layout, rows: number): string {
  const t4 = file.value(ifd, Tag.t4Options, 0);

  let k = -1; // Group 4: two-dimensional, no end-of-line codes.
  let extra = '';
  if (layout.compression === Compression.ccittG3) {
    k = (t4 & 1) !== 0 ? 1 : 0;
    extra += '/EndOfLine true';
    if ((t4 & 4) !== 0) extra += '/EncodedByteAlign true';
  } else if (layout.compression === Compression.ccittRle) {
    // Modified Huffman: one-dimensional, no end-of-line codes, and every row
    // starts on a byte boundary.
    k = 0;
    extra += '/EncodedByteAlign true';
  }

  return (
    `<</K ${k}/Columns ${layout.width}/Rows ${rows}` +
    (layout.photometric === Photometric.blackIsZero ? '/BlackIs1 true' : '') +
    `${extra}>>`
  );
}

/**
 * How many components a JPEG inside a TIFF carries, read from the JPEG rather
 * than from the tags that are supposed to agree with it.
 *
 * Read from the stream because a mismatch here is not a wrong colour but a
 * file no reader will open: PDF requires the colour space to have as many
 * components as the filter produces, and a grayscale scan declared DeviceRGB
 * is a broken PDF. Scanners do write grayscale JPEGs.
 */
function jpegColorSpace(file: TiffFile, layout: Layout): string {
  const first = layout.strips[0]!;
  const components =
    jpegComponents(file.bytes.subarray(first.offset, first.offset + first.length)) ??
    layout.samples;
  return colorSpaceFor(components);
}

export function colorSpaceFor(components: number): string {
  if (components === 1) return '/DeviceGray';
  if (components === 4) return '/DeviceCMYK';
  return '/DeviceRGB';
}

/** The component count from a JPEG's frame header. */
export function jpegComponents(bytes: Uint8Array): number | null {
  let at = 2; // past the start-of-image marker
  while (at + 4 <= bytes.length) {
    if (bytes[at] !== 0xff) {
      at++;
      continue;
    }
    const marker = bytes[at + 1]!;
    // A start-of-frame, in any flavour except the three that are not frames.
    if (
      marker >= 0xc0 && marker <= 0xcf &&
      marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
    ) {
      return at + 9 < bytes.length ? bytes[at + 9]! : null;
    }
    // Markers that carry no length field.
    if (marker === 0x01 || marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd9)) {
      at += 2;
      continue;
    }
    at += 2 + ((bytes[at + 2]! << 8) | bytes[at + 3]!);
  }
  return null;
}

/** A byte with its bits the other way round, for FillOrder 2. */
function reverseBits(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) out[i] = REVERSED[bytes[i]!]!;
  return out;
}

const REVERSED = (() => {
  const table = new Uint8Array(256);
  for (let i = 0; i < 256; i++) {
    let value = i;
    let reversed = 0;
    for (let bit = 0; bit < 8; bit++) {
      reversed = (reversed << 1) | (value & 1);
      value >>= 1;
    }
    table[i] = reversed;
  }
  return table;
})();

// --- the decoding path --------------------------------------------------

/**
 * Everything else: decoded to samples here, then Deflate-compressed.
 *
 * Lossless throughout — Deflate is what PDF's FlateDecode is — so this path
 * costs time and memory but never quality. It is also where the strips stop
 * mattering: they are decompressed and laid into one raster, so a page split
 * into three hundred LZW bands becomes one image object.
 */
async function decodeToFlate(
  file: TiffFile,
  ifd: Ifd,
  layout: Layout,
): Promise<PlacedImage> {
  const { width, height, bitsPerSample, samples } = layout;
  const predictor = file.value(ifd, Tag.predictor, 1);
  const stride = Math.ceil((width * bitsPerSample * samples) / 8);
  const raster = new Uint8Array(stride * height);

  for (const strip of layout.strips) {
    const raw = file.bytes.subarray(strip.offset, strip.offset + strip.length);
    const want = stride * strip.rows;
    const plain = await decompress(raw, layout.compression, want);

    if (predictor === 2) {
      if (bitsPerSample !== 8) {
        throw new TiffUnsupported(
          `it uses horizontal differencing on ${bitsPerSample}-bit samples`,
        );
      }
      undoPredictor(plain, stride, strip.rows, samples);
    }

    raster.set(plain.subarray(0, Math.min(plain.length, want)), strip.firstRow * stride);
  }

  const image = await present(file, ifd, layout, raster, stride);
  return { ...image, at: { x: 0, y: 0, width: layout.pageWidth, height: layout.pageHeight } };
}

async function decompress(
  raw: Uint8Array,
  compression: number,
  want: number,
): Promise<Uint8Array> {
  switch (compression) {
    case Compression.none:
      return raw;
    case Compression.packBits:
      return unpackBits(raw, want);
    case Compression.lzw:
      return lzwDecode(raw, want);
    case Compression.deflate:
    case Compression.deflateOld:
      return inflate(raw);
    default:
      throw new TiffUnsupported(`compression ${compression} is not supported`);
  }
}

/**
 * The raster as a PDF image.
 *
 * Bilevel and grayscale keep their depth: a 1-bit page stays one bit a pixel,
 * which is both smaller and sharper than any 8-bit rendering of it. WhiteIsZero
 * is handled with a Decode array rather than by inverting every byte, since it
 * is a statement about how to read the samples and not a change to them.
 */
async function present(
  file: TiffFile,
  ifd: Ifd,
  layout: Layout,
  raster: Uint8Array,
  stride: number,
): Promise<Omit<PlacedImage, 'at'>> {
  const { width, height, bitsPerSample, samples, photometric } = layout;

  const common = { pixelWidth: width, pixelHeight: height };
  const stream = async (raw: Uint8Array) => {
    const { bytes, compressed } = await deflate(raw);
    return { bytes, filter: compressed ? ('FlateDecode' as const) : null };
  };

  if (photometric === Photometric.palette) {
    const map = file.values(ifd, Tag.colorMap);
    if (map.length < 3) throw new TiffUnsupported('its palette is missing');
    const rgb = expandPalette(raster, stride, width, height, bitsPerSample, map);
    return {
      ...common,
      ...(await stream(rgb)),
      colorSpace: '/DeviceRGB',
      bitsPerComponent: 8,
    };
  }

  if (photometric === Photometric.whiteIsZero || photometric === Photometric.blackIsZero) {
    if (samples !== 1) {
      throw new TiffUnsupported(`a grayscale page declares ${samples} channels`);
    }
    if (![1, 2, 4, 8, 16].includes(bitsPerSample)) {
      throw new TiffUnsupported(`${bitsPerSample}-bit samples are not supported`);
    }
    return {
      ...common,
      ...(await stream(raster)),
      colorSpace: '/DeviceGray',
      bitsPerComponent: bitsPerSample,
      ...(photometric === Photometric.whiteIsZero ? { decode: '[1 0]' } : {}),
    };
  }

  if (photometric === Photometric.rgb || photometric === Photometric.cmyk) {
    const wanted = photometric === Photometric.cmyk ? 4 : 3;
    if (bitsPerSample !== 8 && bitsPerSample !== 16) {
      throw new TiffUnsupported(`${bitsPerSample}-bit colour is not supported`);
    }
    if (samples < wanted) {
      throw new TiffUnsupported(`a colour page declares only ${samples} channels`);
    }
    // Alpha and any other extra samples are dropped rather than composited:
    // the page behind is white, which is what an unmultiplied image over white
    // would give anyway, and PDF needs a soft mask to do better.
    const trimmed =
      samples === wanted
        ? raster
        : dropExtraSamples(raster, width, height, samples, wanted, bitsPerSample / 8);
    return {
      ...common,
      ...(await stream(trimmed)),
      colorSpace: colorSpaceFor(wanted),
      bitsPerComponent: bitsPerSample,
    };
  }

  throw new TiffUnsupported(`photometric interpretation ${photometric} is not supported`);
}

async function deflate(bytes: Uint8Array): Promise<{ bytes: Uint8Array; compressed: boolean }> {
  if (typeof CompressionStream === 'undefined') return { bytes, compressed: false };
  try {
    const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(
      new CompressionStream('deflate'),
    );
    const out = new Uint8Array(await new Response(stream).arrayBuffer());
    return { bytes: out, compressed: true };
  } catch {
    return { bytes, compressed: false };
  }
}

async function inflate(bytes: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === 'undefined') {
    throw new TiffUnsupported('this browser cannot decompress Deflate');
  }
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(
    new DecompressionStream('deflate'),
  );
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Horizontal differencing, undone: each sample is stored as a delta. */
function undoPredictor(data: Uint8Array, stride: number, rows: number, samples: number): void {
  for (let row = 0; row < rows; row++) {
    const start = row * stride;
    for (let i = start + samples; i < start + stride && i < data.length; i++) {
      data[i] = (data[i]! + data[i - samples]!) & 0xff;
    }
  }
}

/**
 * PackBits, which is a run-length scheme with a signed count.
 *
 * Decoded rather than passed to PDF's RunLengthDecode, which is the same idea
 * with one difference that matters: 128 is a no-op here and an end-of-data
 * marker there, so a stream containing one would be truncated silently.
 */
function unpackBits(raw: Uint8Array, want: number): Uint8Array {
  const out = new Uint8Array(want);
  let at = 0;
  let put = 0;

  while (at < raw.length && put < want) {
    const control = raw[at++]!;
    if (control === 128) continue;
    if (control < 128) {
      const run = control + 1;
      for (let i = 0; i < run && at < raw.length && put < want; i++) out[put++] = raw[at++]!;
    } else {
      const run = 257 - control;
      const value = raw[at++]!;
      for (let i = 0; i < run && put < want; i++) out[put++] = value;
    }
  }
  return out;
}

/**
 * LZW as TIFF writes it: codes packed high bit first, widening one code early.
 *
 * The early widening is the detail every implementation gets wrong once. A
 * decoder that waits until the table is genuinely full reads every code after
 * the 511th shifted by a bit, which does not fail — it produces plausible
 * garbage.
 */
function lzwDecode(raw: Uint8Array, want: number): Uint8Array {
  const CLEAR = 256;
  const END = 257;
  const out = new Uint8Array(want);
  let put = 0;

  let table: Uint8Array[] = [];
  let width = 9;
  let next = 258;
  let previous: Uint8Array | null = null;

  const reset = () => {
    table = new Array(258) as Uint8Array[];
    for (let i = 0; i < 256; i++) table[i] = Uint8Array.of(i);
    width = 9;
    next = 258;
    previous = null;
  };
  reset();

  let bitAt = 0;
  const total = raw.length * 8;

  while (bitAt + width <= total) {
    let code = 0;
    for (let i = 0; i < width; i++, bitAt++) {
      code = (code << 1) | ((raw[bitAt >> 3]! >> (7 - (bitAt & 7))) & 1);
    }

    if (code === END) break;
    if (code === CLEAR) {
      reset();
      continue;
    }

    let entry: Uint8Array;
    if (code < next && table[code]) {
      entry = table[code]!;
    } else if (previous) {
      // The one self-referential case: a code for an entry being defined by
      // this very code, which is always the previous string plus its own
      // first byte.
      entry = concat(previous, previous.subarray(0, 1));
    } else {
      break;
    }

    if (put + entry.length > want) {
      out.set(entry.subarray(0, want - put), put);
      put = want;
      break;
    }
    out.set(entry, put);
    put += entry.length;

    if (previous) {
      table[next++] = concat(previous, entry.subarray(0, 1));
      // One code early, which is what TIFF and PDF both mean by LZW.
      if (next + 1 >= 1 << width && width < 12) width++;
    }
    previous = entry;
  }
  return out;
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/** A palette page as plain RGB, which is simpler than PDF's Indexed space. */
function expandPalette(
  raster: Uint8Array,
  stride: number,
  width: number,
  height: number,
  bitsPerSample: number,
  map: number[],
): Uint8Array {
  const entries = 1 << bitsPerSample;
  const out = new Uint8Array(width * height * 3);
  // The map is all the reds, then all the greens, then all the blues, each a
  // 16-bit value.
  const channel = map.length / 3;

  for (let row = 0; row < height; row++) {
    for (let column = 0; column < width; column++) {
      const index = sampleAt(raster, row * stride, column, bitsPerSample) % entries;
      const to = (row * width + column) * 3;
      out[to] = (map[index] ?? 0) >> 8;
      out[to + 1] = (map[channel + index] ?? 0) >> 8;
      out[to + 2] = (map[2 * channel + index] ?? 0) >> 8;
    }
  }
  return out;
}

/** One sample out of a packed row, for depths below a byte. */
function sampleAt(data: Uint8Array, rowAt: number, column: number, bits: number): number {
  if (bits === 8) return data[rowAt + column] ?? 0;
  if (bits === 16) return data[rowAt + column * 2] ?? 0;
  const bitAt = column * bits;
  const byte = data[rowAt + (bitAt >> 3)] ?? 0;
  const shift = 8 - bits - (bitAt & 7);
  return (byte >> shift) & ((1 << bits) - 1);
}

/** The first `wanted` channels of each pixel; alpha and friends go. */
function dropExtraSamples(
  raster: Uint8Array,
  width: number,
  height: number,
  samples: number,
  wanted: number,
  bytesPerSample: number,
): Uint8Array {
  const from = samples * bytesPerSample;
  const to = wanted * bytesPerSample;
  const out = new Uint8Array(width * height * to);
  for (let pixel = 0; pixel < width * height; pixel++) {
    out.set(raster.subarray(pixel * from, pixel * from + to), pixel * to);
  }
  return out;
}
