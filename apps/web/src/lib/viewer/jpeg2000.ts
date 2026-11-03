/**
 * JPEG 2000, opened as PDF.
 *
 * The same trick as `tiff.ts`, and an even shorter one: JPEG 2000 *is* a PDF
 * image filter (`JPXDecode`), so the file is carried into the PDF untouched and
 * the viewer's own decoder reads it. No browser decodes JPEG 2000 either — it
 * is the other format an archive holds and a browser cannot show — but PDF.js
 * ships OpenJPEG as WebAssembly for exactly this filter, and the app already
 * serves it (`wasmUrl`, see `pdf.ts`).
 *
 * So this file never decodes an image. It reads enough of the header to say how
 * big the page is, and writes a dictionary.
 *
 * Two facts about PDF.js decided the design, both read out of the shipped
 * worker rather than assumed:
 *
 *   - `JpxImage.parseImageProperties` scans for the SIZ marker anywhere in the
 *     stream, and `decode` hands the whole buffer to OpenJPEG, whose own format
 *     detection accepts both a `.jp2` wrapper and a bare codestream. So the
 *     file goes in as it arrived, which keeps the `colr` box — the only place
 *     an ICC profile or a non-sRGB space is stated. Stripping down to the bare
 *     codestream, which is what the PDF specification literally asks for, would
 *     throw that away for nothing: this PDF is built for display and discarded,
 *     and PDF.js is its only reader.
 *   - the image's size and depth are taken from the codestream and the
 *     dictionary's are ignored. `/Width` and `/Height` are still written,
 *     because the specification requires them and other readers use them, but
 *     a disagreement would not be what makes a page look wrong.
 */

import { imageDocument, pointsFor } from './pdf-document';

/** When a file declares no resolution, assume its pixels are screen pixels. */
const DEFAULT_DPI = 96;

/** The signature box every `.jp2` family file opens with. */
const JP2_SIGNATURE = [0x00, 0x00, 0x00, 0x0c, 0x6a, 0x50, 0x20, 0x20, 0x0d, 0x0a, 0x87, 0x0a];

export interface Jpeg2000Conversion {
  bytes: Uint8Array;
  width: number;
  height: number;
  components: number;
}

/** A JPEG 2000 this converter will not open. The message follows `tiff.ts`. */
export class Jpeg2000Unsupported extends Error {
  constructor(what: string) {
    super(`${what}.`);
    this.name = 'Jpeg2000Unsupported';
  }
}

export function isJpeg2000(bytes: Uint8Array): boolean {
  if (bytes.length < 12) return false;
  // A bare codestream: start-of-codestream followed by the size marker.
  if (bytes[0] === 0xff && bytes[1] === 0x4f && bytes[2] === 0xff && bytes[3] === 0x51) {
    return true;
  }
  return JP2_SIGNATURE.every((byte, at) => bytes[at] === byte);
}

/** The file, as a one-page PDF that points its own decoder at it. */
export function jpeg2000ToPdf(bytes: Uint8Array): Jpeg2000Conversion {
  if (!isJpeg2000(bytes)) throw new Jpeg2000Unsupported('it is not a JPEG 2000 file');

  const size = codestreamSize(bytes);
  const { xDpi, yDpi } = resolutionOf(bytes);
  const width = pointsFor(size.width, xDpi);
  const height = pointsFor(size.height, yDpi);

  return {
    bytes: imageDocument([
      {
        width,
        height,
        images: [
          {
            bytes,
            pixelWidth: size.width,
            pixelHeight: size.height,
            filter: 'JPXDecode',
            // Both omitted on purpose: for JPXDecode the specification makes
            // the colour space optional and says the depth shall be ignored,
            // because the codestream states them itself.
            at: { x: 0, y: 0, width, height },
          },
        ],
      },
    ]),
    width: size.width,
    height: size.height,
    components: size.components,
  };
}

/**
 * The image size, from the codestream's SIZ marker.
 *
 * Found by scanning rather than by walking the box structure, which is what
 * PDF.js does and means one path serves a `.jp2` wrapper and a bare `.j2k`
 * alike. The size is the reference grid minus its origin: a codestream may
 * start at a non-zero offset, and `Xsiz` alone would then be too large.
 */
function codestreamSize(bytes: Uint8Array): {
  width: number;
  height: number;
  components: number;
} {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  for (let at = 0; at + 1 < bytes.length; at++) {
    if (bytes[at] !== 0xff || bytes[at + 1] !== 0x51) continue;

    // Lsiz, Rsiz, then the grid: Xsiz, Ysiz, XOsiz, YOsiz.
    const siz = at + 2 + 4;
    if (siz + 38 > bytes.length) break;

    const width = view.getUint32(siz) - view.getUint32(siz + 8);
    const height = view.getUint32(siz + 4) - view.getUint32(siz + 12);
    // Past the four tile fields sits the component count.
    const components = view.getUint16(siz + 32);

    if (width <= 0 || height <= 0) {
      throw new Jpeg2000Unsupported('its codestream declares no size');
    }
    return { width, height, components };
  }

  throw new Jpeg2000Unsupported('its codestream has no size marker');
}

/**
 * The resolution, from the capture-resolution box if the file carries one.
 *
 * This is JPEG 2000's equivalent of a JFIF density, and it matters for the
 * same reason: an archival scan at 300dpi should open as a letter-sized page
 * rather than a 26-inch one. The box is optional and often absent, hence the
 * screen-resolution fallback.
 *
 * Note the order inside the box — vertical, then horizontal, which is the
 * reverse of how everything else here is written.
 */
function resolutionOf(bytes: Uint8Array): { xDpi: number; yDpi: number } {
  const header = boxes(bytes, 0, bytes.length).find((box) => box.type === 'jp2h');
  if (!header) return { xDpi: DEFAULT_DPI, yDpi: DEFAULT_DPI };

  const resolution = boxes(bytes, header.from, header.to).find((box) => box.type === 'res ');
  if (!resolution) return { xDpi: DEFAULT_DPI, yDpi: DEFAULT_DPI };

  // Capture resolution is what the scanner recorded; the display grid box is
  // a rendering hint, and only used when there is no capture box.
  const inner = boxes(bytes, resolution.from, resolution.to);
  const box = inner.find((it) => it.type === 'resc') ?? inner.find((it) => it.type === 'resd');
  if (!box || box.to - box.from < 10) return { xDpi: DEFAULT_DPI, yDpi: DEFAULT_DPI };

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const perMetre = (at: number, exponentAt: number) => {
    const numerator = view.getUint16(at);
    const denominator = view.getUint16(at + 2);
    if (denominator === 0) return 0;
    return (numerator / denominator) * 10 ** view.getInt8(exponentAt);
  };

  // Vertical first: VRcN, VRcD, HRcN, HRcD, then the two exponents.
  const vertical = perMetre(box.from, box.from + 8);
  const horizontal = perMetre(box.from + 4, box.from + 9);
  const dpi = (value: number) => (value > 0 ? value * 0.0254 : DEFAULT_DPI);
  return { xDpi: dpi(horizontal), yDpi: dpi(vertical) };
}

interface Box {
  type: string;
  /** The payload, not the header. */
  from: number;
  to: number;
}

/** The boxes directly inside a range, which is how a JP2 file is built. */
function boxes(bytes: Uint8Array, from: number, to: number): Box[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const found: Box[] = [];
  let at = from;

  while (at + 8 <= to) {
    let length = view.getUint32(at);
    let payload = at + 8;

    if (length === 1) {
      // A 64-bit length follows the type, for a box above 4GB. The high word
      // is not read: a box that large is not a page in a viewer.
      if (payload + 8 > to) break;
      length = view.getUint32(payload + 4);
      payload += 8;
    } else if (length === 0) {
      // Runs to the end of the file, which only the last box may do.
      length = to - at;
    }

    const end = at + length;
    if (length < 8 || end > to) break;

    found.push({
      type: String.fromCharCode(bytes[at + 4]!, bytes[at + 5]!, bytes[at + 6]!, bytes[at + 7]!),
      from: payload,
      to: end,
    });
    at = end;
  }
  return found;
}
