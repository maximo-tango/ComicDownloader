// Local test site for manual QA and the end-to-end test.
//   node tests/fixtures/server.mjs [port]   ->  http://localhost:8765/
// Images are generated on the fly as solid-colour PNGs of the requested size.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
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
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'latin1');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
};
const cache = new Map();
export function makePng(w, h, seed = 0) {
  const key = `${w}x${h}:${seed}`;
  if (cache.has(key)) return cache.get(key);
  const [r, g, b] = [(seed * 67) % 200 + 40, (seed * 131) % 200 + 40, (seed * 29) % 200 + 40];
  const row = Buffer.alloc(1 + w * 3);
  for (let x = 0; x < w; x++) row.set(x % 64 < 32 ? [r, g, b] : [255 - r, 255 - g, 255 - b], 1 + x * 3);
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
  cache.set(key, png);
  return png;
}

// Path -> [width, height, seed]. The same seed means "same picture, different size".
export const IMAGES = {
  '/img/plain-large.png': [2400, 1600, 1],
  '/img/sizes/a-480.png': [480, 320, 2],
  '/img/sizes/a-960.png': [960, 640, 2],
  '/img/sizes/a-1920.png': [1920, 1280, 2],
  '/img/pic-small.png': [400, 300, 3],
  '/img/pic-large.png': [1600, 1200, 3],
  '/img/bg-hero.png': [1800, 600, 4],
  '/img/lazy-1.png': [1000, 1400, 5],
  '/img/lazy-2.png': [1000, 1400, 6],
  '/img/gallery/t/cat.png': [200, 150, 7],
  '/img/gallery/full/cat.png': [3200, 2400, 7],
  '/uploads/photo-300x200.png': [300, 200, 8],
  '/uploads/photo.png': [2700, 1800, 8],
  '/img/icon-thumb.png': [64, 64, 9],
  '/img/no-ext-image': [1280, 720, 10],
  '/protected/secret.png': [1500, 1000, 11],
  '/img/dup.png': [900, 900, 12],
  '/img/sizes/b-1x.png': [600, 400, 13],
  '/img/sizes/b-2x.png': [1200, 800, 13],
};

export function startServer(port = 8765) {
  const page = (name) => readFileSync(new URL(name, import.meta.url));
  const server = createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname === '/' || url.pathname === '/index.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(page('test-page.html'));
    }
    if (url.pathname === '/webtoon/1') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end('<!doctype html><title>Episode</title><img src="/img/lazy-1.png"><img src="/img/lazy-2.png">');
    }
    const spec = IMAGES[url.pathname];
    if (!spec) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      return res.end('not found');
    }
    // Hot-link protection: only serve with a Referer from this site.
    if (url.pathname.startsWith('/protected/')) {
      const ref = req.headers.referer || '';
      if (!ref.startsWith(`http://${req.headers.host}/`)) {
        res.writeHead(403, { 'content-type': 'text/plain' });
        return res.end('forbidden');
      }
    }
    const body = makePng(...spec);
    const headers = { 'content-type': 'image/png', 'accept-ranges': 'bytes', 'cache-control': 'no-store' };
    if (url.pathname === '/img/no-ext-image') headers['content-disposition'] = 'inline; filename="server-named.png"';
    const range = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
    if (range) {
      const start = Number(range[1]);
      const end = Math.min(body.length - 1, range[2] ? Number(range[2]) : body.length - 1);
      res.writeHead(206, { ...headers, 'content-range': `bytes ${start}-${end}/${body.length}`, 'content-length': end - start + 1 });
      return res.end(body.subarray(start, end + 1));
    }
    res.writeHead(200, { ...headers, 'content-length': body.length });
    res.end(body);
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.argv[2]) || 8765;
  await startServer(port);
  console.log(`Image Hunter test site: http://localhost:${port}/`);
}
