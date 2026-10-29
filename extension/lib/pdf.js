// Minimal PDF writer (no dependencies). Images are either joined into tall
// pages without gaps (webtoons) or placed one per page.
// JPEG files are embedded as-is (DCTDecode, no quality loss); every other
// format is passed in as zlib-compressed RGB pixels (FlateDecode, lossless).

const enc = new TextEncoder();
const A4 = [595.28, 841.89];
const MAX_PAGE = 14400; // PDF page size limit in points

/**
 * @param images [{ kind: 'jpeg', data, width, height, components: 1 | 3 }
 *                | { kind: 'flate', data, width, height }]   (data: Uint8Array)
 * @param opts   { layout: 'continuous' | 'page' | 'a4', title }
 * @returns Uint8Array[] chunks of the file, in order (wrap them in a Blob)
 */
export function buildPdf(images, { layout = 'continuous', title = '' } = {}) {
  const chunks = [];
  const offsets = [];
  let pos = 0;
  const write = (x) => {
    const b = typeof x === 'string' ? enc.encode(x) : x;
    chunks.push(b);
    pos += b.length;
  };
  const obj = (n, body, stream) => {
    offsets[n] = pos;
    write(`${n} 0 obj\n${body}\n`);
    if (stream) {
      write('stream\n');
      write(stream);
      write('\nendstream\n');
    }
    write('endobj\n');
  };

  // Objects: 1 catalog, 2 page tree, 3 info, one per image, then (page, contents) per page.
  const pages = planPages(images, layout);
  const imgObj = (i) => 4 + i;
  const pageObj = (p) => 4 + images.length + p * 2;
  write('%PDF-1.4\n');
  write(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a])); // binary marker comment
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  obj(2, `<< /Type /Pages /Count ${pages.length} /Kids [${pages.map((_, p) => `${pageObj(p)} 0 R`).join(' ')}] >>`);
  obj(3, `<< /Producer (Image Hunter) /Title ${pdfString(title)} >>`);

  images.forEach((img, i) => {
    // Only greyscale/RGB JPEGs are passed through; the app re-encodes CMYK ones.
    const cs = img.kind === 'jpeg' && img.components === 1 ? '/DeviceGray' : '/DeviceRGB';
    const filter = img.kind === 'jpeg' ? '/DCTDecode' : '/FlateDecode';
    obj(imgObj(i), `<< /Type /XObject /Subtype /Image /Width ${img.width} /Height ${img.height} /ColorSpace ${cs} /BitsPerComponent 8 /Filter ${filter} /Length ${img.data.length} >>`, img.data);
  });

  pages.forEach((pg, p) => {
    const used = [...new Set(pg.items.map((it) => it.index))];
    const xobjects = used.map((i) => `/Im${i} ${imgObj(i)} 0 R`).join(' ');
    obj(pageObj(p), `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${num(pg.width)} ${num(pg.height)}] /Resources << /XObject << ${xobjects} >> >> /Contents ${pageObj(p) + 1} 0 R >>`);
    // PDF y runs upwards; items are laid out from the top of the page.
    // Joined images overlap the next one by 0.5 pt so viewers don't draw a hairline seam.
    const ops = pg.items
      .map((it, k) => {
        const h = it.h + (k < pg.items.length - 1 && pg.items[k + 1].y === it.y + it.h ? 0.5 : 0);
        return `q ${num(it.w)} 0 0 ${num(h)} ${num(it.x)} ${num(pg.height - it.y - h)} cm /Im${it.index} Do Q`;
      })
      .join('\n');
    const content = enc.encode(ops);
    obj(pageObj(p) + 1, `<< /Length ${content.length} >>`, content);
  });

  const xrefPos = pos;
  const count = 4 + images.length + pages.length * 2;
  let xref = `xref\n0 ${count}\n0000000000 65535 f \n`;
  for (let i = 1; i < count; i++) xref += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  write(xref);
  write(`trailer\n<< /Size ${count} /Root 1 0 R /Info 3 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`);
  return chunks;
}

/**
 * Decides pages and where each image goes (points, origin top-left).
 *  continuous: images stacked with no gap, centred, at 1 px = 1 pt; a page is as
 *              tall as the PDF limit allows and breaks only between images, so
 *              the only seams are the few page boundaries.
 *  page / a4:  one image per page.
 * @returns [{ width, height, items: [{ index, x, y, w, h }] }]
 */
export function planPages(images, layout = 'continuous') {
  if (layout !== 'continuous') {
    return images.map((img, index) => {
      const [pw, ph, dx, dy, dw, dh] = pageLayout(img.width, img.height, layout === 'a4' ? 'a4' : 'image');
      return { width: pw, height: ph, items: [{ index, x: dx, y: ph - dy - dh, w: dw, h: dh }] };
    });
  }
  const maxW = Math.max(...images.map((i) => i.width));
  const s = Math.min(1, MAX_PAGE / maxW); // very wide strips: scale everything alike
  const W = maxW * s;
  const pages = [];
  let cur = null;
  images.forEach((img, index) => {
    let w = img.width * s;
    let h = img.height * s;
    if (h > MAX_PAGE) {
      // Taller than any page can be: give it its own page, scaled to fit.
      const k = MAX_PAGE / h;
      w *= k;
      h = MAX_PAGE;
      pages.push({ width: W, height: h, items: [{ index, x: (W - w) / 2, y: 0, w, h }] });
      cur = null;
      return;
    }
    if (!cur || cur.height + h > MAX_PAGE) {
      cur = { width: W, height: 0, items: [] };
      pages.push(cur);
    }
    cur.items.push({ index, x: (W - w) / 2, y: cur.height, w, h });
    cur.height += h;
  });
  return pages;
}

/** Page size and image placement (all in points). */
export function pageLayout(w, h, pageSize) {
  if (pageSize === 'a4') {
    const [pw, ph] = w > h ? [A4[1], A4[0]] : A4; // landscape images get landscape pages
    const margin = 18;
    const s = Math.min((pw - 2 * margin) / w, (ph - 2 * margin) / h);
    const dw = w * s;
    const dh = h * s;
    return [pw, ph, (pw - dw) / 2, (ph - dh) / 2, dw, dh];
  }
  // 1 px = 1 pt, scaled down only when beyond the PDF page size limit.
  const s = Math.min(1, MAX_PAGE / w, MAX_PAGE / h);
  return [w * s, h * s, 0, 0, w * s, h * s];
}

const num = (x) => (Math.round(x * 100) / 100).toString();

function pdfString(s) {
  // UTF-16BE with BOM so Korean titles survive.
  const units = [0xfe, 0xff];
  for (const ch of String(s)) {
    const code = ch.codePointAt(0);
    if (code > 0xffff) {
      const v = code - 0x10000;
      const hi = 0xd800 + (v >> 10);
      const lo = 0xdc00 + (v & 0x3ff);
      units.push(hi >> 8, hi & 0xff, lo >> 8, lo & 0xff);
    } else units.push(code >> 8, code & 0xff);
  }
  return `<${units.map((b) => b.toString(16).padStart(2, '0')).join('')}>`;
}
