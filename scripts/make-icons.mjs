// Generates the extension icons (a page of stacked pictures with a download badge) as PNGs, no dependencies.
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};

function shade(x, y) {
  // Coordinates in a 0..1 square. Returns [r,g,b,a] or null.
  // Rounded square, a tall page of stacked pictures (a webtoon strip) and a
  // download badge in the corner.
  const box = (cx, cy, hw, hh, r) => {
    const qx = Math.max(Math.abs(x - cx) - (hw - r), 0);
    const qy = Math.max(Math.abs(y - cy) - (hh - r), 0);
    return Math.hypot(qx, qy) <= r;
  };
  if (!box(0.5, 0.5, 0.5, 0.5, 0.22)) return null;
  // background: vertical gradient, indigo to violet
  const g = Math.min(1, Math.max(0, y));
  let col = [Math.round(67 + 60 * g), Math.round(56 + 10 * g), Math.round(202 + 20 * g), 255];
  // the page
  if (box(0.4, 0.5, 0.22, 0.34, 0.05)) {
    col = [255, 255, 255, 255];
    // three panels on the page
    if (box(0.4, 0.29, 0.16, 0.085, 0.02)) col = [255, 183, 77, 255];
    if (box(0.4, 0.5, 0.16, 0.085, 0.02)) col = [94, 205, 160, 255];
    if (box(0.4, 0.71, 0.16, 0.085, 0.02)) col = [120, 170, 255, 255];
  }
  // download badge
  const d = Math.hypot(x - 0.72, y - 0.72);
  if (d < 0.22) col = [255, 255, 255, 255];
  if (d < 0.18) {
    col = [244, 81, 108, 255];
    const stem = Math.abs(x - 0.72) < 0.035 && y > 0.6 && y < 0.75;
    const head = y >= 0.69 && y < 0.82 && Math.abs(x - 0.72) < 0.82 - y;
    if (stem || head) col = [255, 255, 255, 255];
  }
  return col;
}

for (const size of [16, 32, 48, 128]) {
  const ss = 4;
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      let acc = [0, 0, 0, 0];
      for (let sy = 0; sy < ss; sy++)
        for (let sx = 0; sx < ss; sx++) {
          const c = shade((x + (sx + 0.5) / ss) / size, (y + (sy + 0.5) / ss) / size);
          if (c) {
            acc[0] += c[0] * c[3]; acc[1] += c[1] * c[3]; acc[2] += c[2] * c[3]; acc[3] += c[3];
          }
        }
      const o = y * (size * 4 + 1) + 1 + x * 4;
      const a = acc[3] / (ss * ss);
      raw[o] = acc[3] ? Math.round(acc[0] / acc[3]) : 0;
      raw[o + 1] = acc[3] ? Math.round(acc[1] / acc[3]) : 0;
      raw[o + 2] = acc[3] ? Math.round(acc[2] / acc[3]) : 0;
      raw[o + 3] = Math.round(a);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  writeFileSync(new URL(`../extension/icons/icon${size}.png`, import.meta.url), png);
}
console.log('icons written');
