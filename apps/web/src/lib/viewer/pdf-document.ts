/**
 * Writing a PDF that holds images, by hand.
 *
 * By hand because the alternative is a PDF-writing library, and what is needed
 * here is one object graph with no text, no fonts and no forms: a page list, a
 * content stream per page, an image per region. That is small enough to read in
 * one sitting, which matters more than usual — the geometry this file produces
 * is the geometry annotations are stored against (`to-pdf.ts`), so it has to be
 * visible rather than behind someone else's defaults.
 *
 * It exists separately from `to-pdf.ts` because a TIFF is not one page and not
 * one image per page: a multi-page scan is N pages, and a stripped scan is one
 * page assembled from a stack of independently compressed bands.
 */

/** A PDF page is measured in points, 72 to the inch. */
export const POINTS_PER_INCH = 72;

/**
 * The filters an image stream may already be in.
 *
 * All four are PDF's own, which is the point: a JPEG, a CCITT fax and a
 * Deflate-compressed raster are each already in a format PDF can read, so the
 * bytes move from the source file into the PDF untouched. Nothing is decoded
 * and nothing is re-encoded, so nothing is lost, and a 300dpi fax page stays
 * the 40kB it was instead of becoming a megabyte of JPEG.
 */
export type ImageFilter =
  | 'DCTDecode'
  | 'CCITTFaxDecode'
  | 'FlateDecode'
  | 'LZWDecode'
  | 'JPXDecode';

export interface PlacedImage {
  /** The stream, already in `filter`'s encoding. */
  bytes: Uint8Array;
  /** Dimensions of the sample grid, in pixels. */
  pixelWidth: number;
  pixelHeight: number;
  filter: ImageFilter | null;
  /** `<<…>>` for the filter, written verbatim. */
  decodeParms?: string;
  /**
   * `/DeviceGray`, `/DeviceRGB`, `/DeviceCMYK`.
   *
   * Both this and the depth are omitted for a JPXDecode image, where the
   * specification makes the colour space optional and says a declared depth
   * shall be ignored: a JPEG 2000 codestream states them itself, and repeating
   * them here could only disagree with it.
   */
  colorSpace?: string;
  bitsPerComponent?: number;
  /** `[1 0]` to show the samples inverted, which is how WhiteIsZero is said. */
  decode?: string;
  /** Where to paint it, in points, from the bottom-left of the page. */
  at: { x: number; y: number; width: number; height: number };
}

export interface ImagePage {
  /** The media box, in points. */
  width: number;
  height: number;
  /**
   * Painted in order, so later entries land on top. A stripped scan is a
   * column of bands that happen not to overlap.
   */
  images: PlacedImage[];
}

/**
 * A complete PDF.
 *
 * Object numbers are handed out before anything is written, because an indirect
 * reference has to name an object that is written later: the catalogue refers to
 * the page tree, every page refers to its content stream and its images. They
 * are then written in ascending order, which is what lets the cross-reference
 * table be built from a running offset rather than a second pass.
 */
export function imageDocument(pages: ImagePage[]): Uint8Array {
  if (pages.length === 0) throw new Error('a PDF needs at least one page');

  const n = pages.length;
  const pageNumber = (i: number) => 3 + i;
  const contentNumber = (i: number) => 3 + n + i;

  // Images are numbered after every page and content stream, in page order.
  const imageNumbers: number[][] = [];
  let next = 3 + 2 * n;
  for (const page of pages) {
    imageNumbers.push(page.images.map(() => next++));
  }
  const total = next - 1;

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
  object(
    `<</Type/Pages/Kids[${pages.map((_, i) => `${pageNumber(i)} 0 R`).join(' ')}]` +
      `/Count ${n}>>`,
  );

  pages.forEach((page, i) => {
    const resources = imageNumbers[i]!
      .map((number, k) => `/Im${k} ${number} 0 R`)
      .join('');
    object(
      `<</Type/Page/Parent 2 0 R/MediaBox[0 0 ${size(page.width)} ${size(page.height)}]` +
        `/Resources<</XObject<<${resources}>>>>/Contents ${contentNumber(i)} 0 R>>`,
    );
  });

  pages.forEach((page) => {
    // `cm` maps the unit square each image is painted into onto its place on
    // the page; `q`/`Q` keep one image's transform out of the next one's.
    const content = encode(
      page.images
        .map(
          ({ at }, k) =>
            `q\n${size(at.width)} 0 0 ${size(at.height)} ${size(at.x)} ${size(at.y)} cm\n` +
            `/Im${k} Do\nQ\n`,
        )
        .join(''),
    );
    object(`<</Length ${content.length}>>`, content);
  });

  for (const page of pages) {
    for (const image of page.images) {
      object(
        `<</Type/XObject/Subtype/Image` +
          `/Width ${image.pixelWidth}/Height ${image.pixelHeight}` +
          (image.colorSpace ? `/ColorSpace${image.colorSpace}` : '') +
          (image.bitsPerComponent ? `/BitsPerComponent ${image.bitsPerComponent}` : '') +
          (image.filter ? `/Filter/${image.filter}` : '') +
          (image.decodeParms ? `/DecodeParms${image.decodeParms}` : '') +
          (image.decode ? `/Decode${image.decode}` : '') +
          `/Length ${image.bytes.length}>>`,
        image.bytes,
      );
    }
  }

  const xref = out.length;
  out.text(`xref\n0 ${total + 1}\n0000000000 65535 f \n`);
  for (const at of offsets) out.text(`${String(at).padStart(10, '0')} 00000 n \n`);
  out.text(`trailer\n<</Size ${total + 1}/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF\n`);

  return out.done();
}

/**
 * Points, to three decimals and never in exponent form.
 *
 * `String(0.0000001)` is `1e-7`, which is not a PDF number and would make the
 * file unreadable rather than merely wrong — worth the rounding either way,
 * since nothing here is measured more finely than a thousandth of a point.
 */
function size(value: number): string {
  const rounded = Math.round(value * 1000) / 1000;
  return Number.isFinite(rounded) ? String(rounded) : '0';
}

/** Points for a run of pixels at a given resolution. */
export function pointsFor(pixels: number, dpi: number): number {
  return (pixels * POINTS_PER_INCH) / dpi;
}

const encode = (s: string) => new TextEncoder().encode(s);

/** Appends bytes, and knows the offset of every one — which the xref needs. */
export class Writer {
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
