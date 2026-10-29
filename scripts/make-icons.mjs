// Generates the extension icons (magnifier over a picture frame) as PNGs, no dependencies.
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
  const dist = (ax, ay, bx, by) => Math.hypot(ax - bx, ay - by);
  // rounded-square background
  const r = 0.2;
  const qx = Math.max(Math.abs(x - 0.5) - (0.5 - r), 0);
  const qy = Math.max(Math.abs(y - 0.5) - (0.5 - r), 0);
  if (Math.hypot(qx, qy) > r) return null;
  let col = [47, 111, 237, 255];
  // handle: segment from the lens rim towards the bottom-right corner
  const t = Math.max(0, Math.min(1, ((x - 0.6) + (y - 0.6)) / (2 * 0.2)));
  if (dist(x, y, 0.6 + t * 0.2, 0.6 + t * 0.2) < 0.07) col = [255, 255, 255, 255];
  // lens ring + glass
  const d = dist(x, y, 0.43, 0.43);
  if (d < 0.25) col = [222, 233, 255, 255];
  if (d >= 0.2 && d < 0.27) col = [255, 255, 255, 255];
  // tiny mountain picture inside the lens
  if (d < 0.2) {
    if (y > 0.47 && y - 0.47 > Math.abs(x - 0.38) * 1.1 - 0.12 + 0.0 && y < 0.62) col = [46, 160, 98, 255];
    if (dist(x, y, 0.5, 0.36) < 0.045) col = [255, 186, 59, 255];
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
