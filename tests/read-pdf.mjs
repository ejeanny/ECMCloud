/**
 * Reading back a PDF written by `pdf-document.ts`.
 *
 * Shared by the converter suites, which all assert against the same shapes:
 * the pages, their boxes, and the images each page paints.
 */

/**
 * The objects of a PDF written by `pdf-document.ts`.
 *
 * A real PDF parser is not needed and would hide what is being asserted: the
 * writer emits `N 0 obj`, one dictionary, and an optional stream of exactly
 * `/Length` bytes. Reading it back this plainly also means the test would
 * notice the writer changing shape.
 */
export function objects(bytes) {
  const text = Buffer.from(bytes).toString('latin1');
  const found = new Map();
  const header = /(\d+) 0 obj\n/g;
  let match;

  while ((match = header.exec(text)) !== null) {
    const from = match.index + match[0].length;
    const open = text.indexOf('<<', from);
    if (open === -1) continue;

    // Dictionaries nest, so the end of this one is where the depth returns.
    let depth = 0;
    let at = open;
    for (; at < text.length; at++) {
      if (text.startsWith('<<', at)) {
        depth++;
        at++;
      } else if (text.startsWith('>>', at)) {
        depth--;
        at++;
        if (depth === 0) break;
      }
    }
    const dict = text.slice(open, at + 1);

    let stream = null;
    const marker = `${dict}\nstream\n`;
    if (text.startsWith(marker, open)) {
      const length = Number(/\/Length (\d+)/.exec(dict)?.[1] ?? 0);
      const start = open + marker.length;
      stream = bytes.subarray(start, start + length);
    }
    found.set(Number(match[1]), { dict, stream });
  }
  return found;
}

/** The pages, in order, each with the images its content stream paints. */
export function pagesOf(bytes) {
  const all = objects(bytes);
  const tree = all.get(2);
  const order = [...(tree?.dict.matchAll(/(\d+) 0 R/g) ?? [])].map((m) => Number(m[1]));

  return order.map((number) => {
    const page = all.get(number);
    const box = /\/MediaBox\[0 0 ([\d.]+) ([\d.]+)\]/.exec(page.dict);
    const resources = [...page.dict.matchAll(/\/Im(\d+) (\d+) 0 R/g)];
    const contentNumber = Number(/\/Contents (\d+) 0 R/.exec(page.dict)[1]);
    const content = Buffer.from(all.get(contentNumber).stream).toString('latin1');

    // `w 0 0 h x y cm` then `/ImN Do`: where each image was placed.
    const placed = [...content.matchAll(
      /([\d.-]+) 0 0 ([\d.-]+) ([\d.-]+) ([\d.-]+) cm\n\/Im(\d+) Do/g,
    )];

    return {
      size: [Number(box[1]), Number(box[2])],
      images: placed.map((paint) => {
        const slot = paint[5];
        const number = Number(resources.find((entry) => entry[1] === slot)[2]);
        const image = all.get(number);
        return {
          dict: image.dict,
          stream: image.stream,
          at: [Number(paint[3]), Number(paint[4]), Number(paint[1]), Number(paint[2])],
        };
      }),
    };
  });
}
