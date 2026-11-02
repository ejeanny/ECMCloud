/**
 * Turning other formats into PDF, so one viewer can open them.
 *
 * This is Apryse's `loadAsPDF` (PDF-VIEWER.md §2), reproduced. Dokmee's viewer
 * shows Word, Excel, email and scans through a single code path because
 * WebViewer converts each of them to PDF before display — its core bundle
 * carries `officeToPDFBuffer` and an `ElementBuilder`/`PageSize` image path for
 * exactly that [observed]. The alternative, a renderer per format, is the one
 * this rebuild started with, and it costs a viewer per format: an image opened
 * as an `<img>` has no annotations, no text layer, no search, no page
 * thumbnails, because all of that is built on PDF pages.
 *
 * So: convert, then open. Everything downstream stays as it is.
 *
 * What runs here runs in the browser, on bytes already downloaded for display.
 * Nothing is sent anywhere, and the converted PDF is never stored — it exists
 * for as long as the document is open. That matters for annotations: a mark
 * made on a converted page is stored against geometry this file produced, so
 * the conversion has to be deterministic. It is: the same bytes give the same
 * page box every time.
 */

/** A PDF page is measured in points; CSS pixels are 96 to the inch. */
const DEFAULT_DPI = 96;
const POINTS_PER_INCH = 72;

export interface Converted {
  bytes: Uint8Array;
  /** What the conversion did, for the viewer to say so. */
  note: string;
}

/**
 * Is this a format we open by turning it into a PDF?
 *
 * Raster images only. SVG and ICO stay with the plain image renderer on
 * purpose: one is vector art that a reader should be able to zoom without
 * resampling, the other is several sizes in one file, and flattening either to
 * a single raster page to gain annotations is a poor trade. Neither is a
 * document anyone marks up.
 */
export function convertsToPdf(ext: string | null | undefined): boolean {
  return RASTER_EXT.has((ext ?? '').toLowerCase());
}

const RASTER_EXT = new Set(['png', 'jpg', 'jpeg', 'jfif', 'gif', 'webp', 'bmp', 'avif']);

/**
 * One image, one PDF page.
 *
 * A JPEG is embedded exactly as it arrived — JPEG is already a PDF image
 * filter (`DCTDecode`), so re-encoding it would cost a generation of quality
 * and a good deal of time for nothing. That is the case that matters, since a
 * scanned page is almost always a JPEG. Anything else the browser can decode
 * goes through a canvas and comes out as JPEG.
 */
export async function imageToPdf(blob: Blob): Promise<Converted> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const image = await decode(blob);

  try {
    const { width, height } = sizeOf(image);
    const jpeg = isJpeg(bytes);
    const payload = jpeg ? bytes : await reencode(image);
    const dpi = (jpeg ? jfifDpi(bytes) : null) ?? pngDpi(bytes) ?? DEFAULT_DPI;

    return {
      bytes: onePageDocument(payload, width, height, dpi),
      note: jpeg
        ? 'Opened as PDF (image embedded unchanged)'
        : 'Opened as PDF (image re-encoded)',
    };
  } finally {
    if (!(image instanceof HTMLImageElement)) image.close();
  }
}

/**
 * Decode through an `<img>` rather than `createImageBitmap`.
 *
 * `createImageBitmap` is the faster path and handles most of these, but it
 * refuses an SVG without an intrinsic width and height, which is most SVGs
 * written by hand. The element accepts them, and the difference only shows up
 * on formats we would otherwise have to exclude.
 */
async function decode(blob: Blob): Promise<ImageBitmap | HTMLImageElement> {
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    if (img.naturalWidth === 0 || img.naturalHeight === 0) {
      throw new Error('the image declares no size');
    }
    // `decode()` resolves before `naturalWidth` is readable in no browser we
    // support, but the element has to outlive the object URL, so copy it out.
    const bitmap = await createImageBitmap(img).catch(() => null);
    return bitmap ?? img;
  } finally {
    // Safe once decoding has finished: the bitmap no longer refers to the URL.
    URL.revokeObjectURL(url);
  }
}

type Decoded = ImageBitmap | HTMLImageElement;

function sizeOf(image: Decoded): { width: number; height: number } {
  return image instanceof HTMLImageElement
    ? { width: image.naturalWidth, height: image.naturalHeight }
    : { width: image.width, height: image.height };
}

async function reencode(image: Decoded): Promise<Uint8Array> {
  const { width, height } = sizeOf(image);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('no 2D context for image conversion');

  // A PDF page is white, and a transparent PNG drawn straight onto a fresh
  // canvas keeps its alpha — which JPEG cannot carry, so every transparent
  // pixel would come out black.
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(image, 0, 0);

  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, 'image/jpeg', 0.92),
  );
  if (!blob) throw new Error('the image could not be encoded');
  return new Uint8Array(await blob.arrayBuffer());
}

function isJpeg(bytes: Uint8Array): boolean {
  return bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

/**
 * The resolution a JPEG declares in its JFIF header, if it declares one.
 *
 * Without it a 300dpi scan would be laid out as though its pixels were screen
 * pixels, and a letter-sized page would open as a 26-inch one. Everything
 * still *looks* right — it is one image on one page either way — but the page
 * size is what print, page-fit and any measurement read, so it is worth the
 * dozen lines.
 */
function jfifDpi(bytes: Uint8Array): number | null {
  // APP0 immediately follows SOI in a JFIF file: ff d8 ff e0 <len> "JFIF\0".
  if (bytes.length < 18 || bytes[3] !== 0xe0) return null;
  const tag = String.fromCharCode(bytes[6]!, bytes[7]!, bytes[8]!, bytes[9]!);
  if (tag !== 'JFIF') return null;

  const units = bytes[13];
  const x = (bytes[14]! << 8) | bytes[15]!;
  if (x <= 0) return null;
  if (units === 1) return x; // pixels per inch
  if (units === 2) return x * 2.54; // pixels per centimetre
  return null; // units 0: an aspect ratio, not a resolution
}

/** The same for a PNG's optional `pHYs` chunk, which is in pixels per metre. */
function pngDpi(bytes: Uint8Array): number | null {
  if (bytes.length < 8 || bytes[0] !== 0x89 || bytes[1] !== 0x50) return null;
  let at = 8;
  while (at + 8 <= bytes.length) {
    const length = readU32(bytes, at);
    const type = String.fromCharCode(bytes[at + 4]!, bytes[at + 5]!, bytes[at + 6]!, bytes[at + 7]!);
    if (type === 'pHYs' && at + 17 <= bytes.length) {
      const perMetre = readU32(bytes, at + 8);
      const unit = bytes[at + 16];
      return unit === 1 && perMetre > 0 ? perMetre * 0.0254 : null;
    }
    // Chunks run until IDAT; pHYs is required to come before it.
    if (type === 'IDAT') return null;
    at += 12 + length;
  }
  return null;
}

function readU32(bytes: Uint8Array, at: number): number {
  return (
    ((bytes[at]! << 24) | (bytes[at + 1]! << 16) | (bytes[at + 2]! << 8) | bytes[at + 3]!) >>> 0
  );
}

/**
 * A complete PDF holding one image, written by hand.
 *
 * Hand-written because the alternative is a PDF-writing library, and a
 * one-page image document is five objects and an xref table — far less than
 * the dependency, and it keeps the geometry the annotations are stored against
 * visible in this file rather than behind someone else's defaults.
 */
function onePageDocument(
  image: Uint8Array,
  pixelWidth: number,
  pixelHeight: number,
  dpi: number,
): Uint8Array {
  const width = round(((pixelWidth * POINTS_PER_INCH) / dpi) * 1000) / 1000;
  const height = round(((pixelHeight * POINTS_PER_INCH) / dpi) * 1000) / 1000;

  const out = new Writer();
  const offsets: number[] = [];
  out.text('%PDF-1.7\n');
  // A comment of high bytes, which tells anything sniffing the file that it is
  // binary and must not be newline-translated in transit.
  out.bytes(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));

  const object = (body: string, stream?: Uint8Array) => {
    offsets.push(out.length);
    out.text(`${offsets.length} 0 obj\n${body}\n`);
    if (stream) {
      out.text('stream\n');
      out.bytes(stream);
      out.text('\nendstream\n');
    }
    out.text('endobj\n');
  };

  object('<</Type/Catalog/Pages 2 0 R>>');
  object('<</Type/Pages/Kids[3 0 R]/Count 1>>');
  object(
    `<</Type/Page/Parent 2 0 R/MediaBox[0 0 ${width} ${height}]` +
      `/Resources<</XObject<</Im0 5 0 R>>>>/Contents 4 0 R>>`,
  );

  // Scale the unit image square up to the page: `cm` is the transform, `Do`
  // paints. `q`/`Q` keep it from leaking into anything drawn later.
  const content = encode(`q\n${width} 0 0 ${height} 0 0 cm\n/Im0 Do\nQ\n`);
  object(`<</Length ${content.length}>>`, content);

  object(
    `<</Type/XObject/Subtype/Image/Width ${pixelWidth}/Height ${pixelHeight}` +
      `/ColorSpace/DeviceRGB/BitsPerComponent 8/Filter/DCTDecode/Length ${image.length}>>`,
    image,
  );

  const xref = out.length;
  out.text(`xref\n0 ${offsets.length + 1}\n0000000000 65535 f \n`);
  for (const at of offsets) out.text(`${String(at).padStart(10, '0')} 00000 n \n`);
  out.text(
    `trailer\n<</Size ${offsets.length + 1}/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF\n`,
  );

  return out.done();
}

const round = Math.round;
const encode = (s: string) => new TextEncoder().encode(s);

/** Appends bytes, and knows the offset of every one — which the xref needs. */
class Writer {
  #parts: Uint8Array[] = [];
  length = 0;

  text(value: string): void {
    this.bytes(encode(value));
  }

  bytes(value: Uint8Array): void {
    this.#parts.push(value);
    this.length += value.length;
  }

  done(): Uint8Array {
    const out = new Uint8Array(this.length);
    let at = 0;
    for (const part of this.#parts) {
      out.set(part, at);
      at += part.length;
    }
    return out;
  }
}
