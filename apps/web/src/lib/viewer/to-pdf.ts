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

import { imageDocument, pointsFor, type PlacedImage } from './pdf-document';
import { colorSpaceFor, isTiff, jpegComponents, tiffToPdf } from './tiff';

/** A PDF page is measured in points; CSS pixels are 96 to the inch. */
const DEFAULT_DPI = 96;

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
 *
 * TIFF is here because it is the opposite of those two: it is what a scanner
 * writes, it is the one common image format that holds many pages, and it is
 * the format most likely to be marked up in an ECM. See `tiff.ts`.
 */
export function convertsToPdf(ext: string | null | undefined): boolean {
  return RASTER_EXT.has((ext ?? '').toLowerCase());
}

const RASTER_EXT = new Set([
  'png', 'jpg', 'jpeg', 'jfif', 'gif', 'webp', 'bmp', 'avif', 'tif', 'tiff',
]);

/**
 * An image, as a PDF.
 *
 * A TIFF takes its own road, because it is the one format here the browser
 * cannot decode and the one that can hold more than a single page.
 *
 * Everything else is one image on one page. A JPEG is embedded exactly as it
 * arrived — JPEG is already a PDF image filter (`DCTDecode`), so re-encoding it
 * would cost a generation of quality and a good deal of time for nothing. That
 * is the case that matters, since a scanned page is almost always a JPEG.
 * Anything else the browser can decode goes through a canvas and comes out as
 * JPEG.
 */
export async function imageToPdf(blob: Blob): Promise<Converted> {
  const bytes = new Uint8Array(await blob.arrayBuffer());

  if (isTiff(bytes)) {
    const tiff = await tiffToPdf(bytes);
    const pages = tiff.pages === 1 ? '1 page' : `${tiff.pages} pages`;
    return {
      bytes: tiff.bytes,
      note: tiff.passedThrough
        ? `Opened as PDF (${pages}, scan embedded unchanged)`
        : `Opened as PDF (${pages}, recompressed losslessly)`,
    };
  }

  const image = await decode(blob);
  try {
    const { width, height } = sizeOf(image);
    const jpeg = isJpeg(bytes);
    const payload = jpeg ? bytes : await reencode(image);
    const dpi = (jpeg ? jfifDpi(bytes) : null) ?? pngDpi(bytes) ?? DEFAULT_DPI;

    // Read from the stream, not assumed: PDF requires the colour space to have
    // as many components as the filter produces, and a grayscale scan declared
    // DeviceRGB is a PDF no reader will open. A canvas always gives three.
    const components = jpeg ? (jpegComponents(payload) ?? 3) : 3;

    return {
      bytes: onePage(payload, width, height, dpi, colorSpaceFor(components)),
      note: jpeg
        ? 'Opened as PDF (image embedded unchanged)'
        : 'Opened as PDF (image re-encoded)',
    };
  } finally {
    if (!(image instanceof HTMLImageElement)) image.close();
  }
}

/** One image, one page, sized by the resolution the image declares. */
function onePage(
  payload: Uint8Array,
  pixelWidth: number,
  pixelHeight: number,
  dpi: number,
  colorSpace: string,
): Uint8Array {
  const width = pointsFor(pixelWidth, dpi);
  const height = pointsFor(pixelHeight, dpi);

  const image: PlacedImage = {
    bytes: payload,
    pixelWidth,
    pixelHeight,
    filter: 'DCTDecode',
    colorSpace,
    bitsPerComponent: 8,
    at: { x: 0, y: 0, width, height },
  };
  return imageDocument([{ width, height, images: [image] }]);
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
