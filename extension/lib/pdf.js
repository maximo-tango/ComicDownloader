// Minimal PDF writer (no dependencies): one image per page.
// JPEG files are embedded as-is (DCTDecode, no quality loss); every other
// format is passed in as zlib-compressed RGB pixels (FlateDecode, lossless).

const enc = new TextEncoder();
const A4 = [595.28, 841.89];
const MAX_PAGE = 14400; // PDF page size limit in points

/**
 * @param pages [{ kind: 'jpeg', data, width, height, components: 1 | 3 }
 *               | { kind: 'flate', data, width, height }]   (data: Uint8Array)
 * @param opts  { pageSize: 'image' | 'a4', title }
 * @returns Uint8Array[] chunks of the file, in order (wrap them in a Blob)
 */
export function buildPdf(pages, { pageSize = 'image', title = '' } = {}) {
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

  // Object numbers: 1 catalog, 2 pages, 3 info, then 3 per page (page, image, contents)
  const n = pages.length;
  const pageObj = (i) => 4 + i * 3;
  write('%PDF-1.4\n');
  write(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a])); // binary marker comment
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  obj(2, `<< /Type /Pages /Count ${n} /Kids [${pages.map((_, i) => `${pageObj(i)} 0 R`).join(' ')}] >>`);
  obj(3, `<< /Producer (Image Hunter) /Title ${pdfString(title)} >>`);

  pages.forEach((p, i) => {
    const [pw, ph, dx, dy, dw, dh] = layout(p.width, p.height, pageSize);
    const imgN = pageObj(i) + 1;
    const contN = pageObj(i) + 2;
    obj(pageObj(i), `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${num(pw)} ${num(ph)}] /Resources << /XObject << /Im0 ${imgN} 0 R >> >> /Contents ${contN} 0 R >>`);
    // Only greyscale/RGB JPEGs are passed through; the app re-encodes CMYK ones.
    const cs = p.kind === 'jpeg' && p.components === 1 ? '/DeviceGray' : '/DeviceRGB';
    const extra = '';
    const filter = p.kind === 'jpeg' ? '/DCTDecode' : '/FlateDecode';
    obj(imgN, `<< /Type /XObject /Subtype /Image /Width ${p.width} /Height ${p.height} /ColorSpace ${cs} /BitsPerComponent 8 /Filter ${filter}${extra} /Length ${p.data.length} >>`, p.data);
    const content = enc.encode(`q ${num(dw)} 0 0 ${num(dh)} ${num(dx)} ${num(dy)} cm /Im0 Do Q`);
    obj(contN, `<< /Length ${content.length} >>`, content);
  });

  const xrefPos = pos;
  const count = 4 + n * 3;
  let xref = `xref\n0 ${count}\n0000000000 65535 f \n`;
  for (let i = 1; i < count; i++) xref += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  write(xref);
  write(`trailer\n<< /Size ${count} /Root 1 0 R /Info 3 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`);
  return chunks;
}

/** Page size and image placement (all in points). */
export function layout(w, h, pageSize) {
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
