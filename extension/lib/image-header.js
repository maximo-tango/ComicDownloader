// Reads format and pixel size from the first bytes of an image file, so the
// resolver can verify a candidate without downloading the whole thing.
// Returns { format, width, height } (width/height may be missing) or null.

const u16be = (b, i) => (b[i] << 8) | b[i + 1];
const u16le = (b, i) => b[i] | (b[i + 1] << 8);
const u24le = (b, i) => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16);
const u32be = (b, i) => ((b[i] << 24) >>> 0) + ((b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]);
const i32le = (b, i) => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24);
const ascii = (b, i, n) => String.fromCharCode(...b.subarray(i, i + n));

export function parseImageHeader(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (b.length < 12) return sniffSvg(b);

  if (b[0] === 0x89 && ascii(b, 1, 3) === 'PNG') {
    return b.length >= 24 && ascii(b, 12, 4) === 'IHDR'
      ? { format: 'PNG', width: u32be(b, 16), height: u32be(b, 20) }
      : { format: 'PNG' };
  }
  if (ascii(b, 0, 4) === 'GIF8') return { format: 'GIF', width: u16le(b, 6), height: u16le(b, 8) };
  if (b[0] === 0xff && b[1] === 0xd8) return parseJpeg(b);
  if (ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP') return parseWebp(b);
  if (ascii(b, 4, 4) === 'ftyp') return parseIsoBmff(b);
  if (b[0] === 0x42 && b[1] === 0x4d && b.length >= 26) {
    return { format: 'BMP', width: i32le(b, 18), height: Math.abs(i32le(b, 22)) };
  }
  if (b[0] === 0 && b[1] === 0 && b[2] === 1 && b[3] === 0) {
    return { format: 'ICO', width: b[6] || 256, height: b[7] || 256 };
  }
  if (ascii(b, 0, 4) === 'II*\0' || ascii(b, 0, 4) === 'MM\0*') return { format: 'TIFF' };
  return sniffSvg(b);
}

function parseJpeg(b) {
  const d = jpegDetails(b);
  if (!d) return { format: 'JPEG' };
  // EXIF orientations 5-8 rotate by 90°, which is how browsers display them.
  return d.orientation >= 5 && d.orientation <= 8
    ? { format: 'JPEG', width: d.height, height: d.width }
    : { format: 'JPEG', width: d.width, height: d.height };
}

/**
 * Stored (unrotated) size, colour components and EXIF orientation of a JPEG,
 * or null when the frame header is not within the given bytes.
 */
export function jpegDetails(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (!(b[0] === 0xff && b[1] === 0xd8)) return null;
  let i = 2;
  let orientation = 1;
  let adobe = false;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) { i++; continue; }
    const marker = b[i + 1];
    if (marker === 0xff) { i++; continue; }
    if ((marker >= 0xd0 && marker <= 0xd9) || marker === 0x01) { i += 2; continue; }
    const len = u16be(b, i + 2);
    if (marker === 0xe1 && ascii(b, i + 4, 6) === 'Exif\0\0') {
      orientation = readExifOrientation(b, i + 10, Math.min(b.length, i + 2 + len)) || 1;
    }
    if (marker === 0xee && ascii(b, i + 4, 5) === 'Adobe') adobe = true;
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      return { height: u16be(b, i + 5), width: u16be(b, i + 7), components: b[i + 9], orientation, adobe, progressive: marker === 0xc2 };
    }
    i += 2 + len;
  }
  return null;
}

function readExifOrientation(b, start, end) {
  if (start + 8 > end) return null;
  const le = ascii(b, start, 2) === 'II';
  const r16 = (i) => (le ? u16le(b, i) : u16be(b, i));
  const r32 = (i) => (le ? (i32le(b, i) >>> 0) : u32be(b, i));
  const ifd = start + r32(start + 4);
  if (ifd + 2 > end) return null;
  const count = r16(ifd);
  for (let n = 0; n < count; n++) {
    const e = ifd + 2 + n * 12;
    if (e + 12 > end) return null;
    if (r16(e) === 0x0112) return r16(e + 8);
  }
  return null;
}

function parseWebp(b) {
  const chunk = ascii(b, 12, 4);
  if (chunk === 'VP8 ' && b.length >= 30) {
    return { format: 'WEBP', width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff };
  }
  if (chunk === 'VP8L' && b.length >= 25) {
    const bits = (b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24)) >>> 0;
    return { format: 'WEBP', width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  if (chunk === 'VP8X' && b.length >= 30) {
    return { format: 'WEBP', width: u24le(b, 24) + 1, height: u24le(b, 27) + 1 };
  }
  return { format: 'WEBP' };
}

function parseIsoBmff(b) {
  const boxSize = u32be(b, 0);
  const brands = [];
  for (let i = 8; i + 4 <= Math.min(boxSize, b.length); i += 4) {
    if (i !== 12) brands.push(ascii(b, i, 4)); // skip minor_version
  }
  let format = null;
  if (brands.some((x) => x === 'avif' || x === 'avis')) format = 'AVIF';
  else if (brands.some((x) => /^(heic|heix|heim|heis|hevc|hevx|mif1|msf1)$/.test(x))) format = 'HEIC';
  if (!format) return null;
  // Largest 'ispe' (image spatial extents) box is the primary image;
  // smaller ones belong to thumbnails or grid tiles.
  let best = null;
  for (let p = 0; p + 16 <= b.length; p++) {
    if (b[p] === 0x69 && ascii(b, p, 4) === 'ispe') {
      const w = u32be(b, p + 8);
      const h = u32be(b, p + 12);
      if (!best || w * h > best.width * best.height) best = { width: w, height: h };
    }
  }
  return best ? { format, ...best } : { format };
}

function sniffSvg(b) {
  const text = new TextDecoder('utf-8', { fatal: false }).decode(b.subarray(0, 4096));
  const m = /<svg\b[^>]*>/i.exec(text);
  if (!m) return null;
  const tag = m[0];
  const attr = (n) => {
    const r = new RegExp(`\\s${n}\\s*=\\s*["']\\s*([\\d.]+)(px)?\\s*["']`, 'i').exec(tag);
    return r ? Math.round(parseFloat(r[1])) : null;
  };
  let width = attr('width');
  let height = attr('height');
  if (!width || !height) {
    const vb = /viewBox\s*=\s*["']\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(tag);
    if (vb) {
      width = Math.round(parseFloat(vb[1]));
      height = Math.round(parseFloat(vb[2]));
    }
  }
  return width && height ? { format: 'SVG', width, height } : { format: 'SVG' };
}
