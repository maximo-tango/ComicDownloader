import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseImageHeader } from '../extension/lib/image-header.js';
import { gifHeader, jpegHeader, pngHeader, webpVp8xHeader } from './helpers.js';

test('PNG dimensions', () => {
  assert.deepEqual(parseImageHeader(pngHeader(3840, 2560)), { format: 'PNG', width: 3840, height: 2560 });
});

test('JPEG dimensions, skipping other segments', () => {
  assert.deepEqual(parseImageHeader(jpegHeader(1920, 1080, { padding: 500 })), { format: 'JPEG', width: 1920, height: 1080 });
});

test('JPEG with EXIF orientation 6 reports displayed (rotated) size', () => {
  assert.deepEqual(parseImageHeader(jpegHeader(4000, 3000, { orientation: 6 })), { format: 'JPEG', width: 3000, height: 4000 });
});

test('JPEG truncated before SOF still reports the format', () => {
  const full = jpegHeader(100, 100, { padding: 2000 });
  assert.deepEqual(parseImageHeader(full.subarray(0, 600)), { format: 'JPEG' });
});

test('GIF and WebP (VP8X)', () => {
  assert.deepEqual(parseImageHeader(gifHeader(320, 240)), { format: 'GIF', width: 320, height: 240 });
  assert.deepEqual(parseImageHeader(webpVp8xHeader(1200, 800)), { format: 'WEBP', width: 1200, height: 800 });
});

test('AVIF picks the largest ispe box', () => {
  const box = (type, payload) => {
    const b = new Uint8Array(8 + payload.length);
    new DataView(b.buffer).setUint32(0, b.length);
    b.set([...type].map((c) => c.charCodeAt(0)), 4);
    b.set(payload, 8);
    return b;
  };
  const ispe = (w, h) => {
    const p = new Uint8Array(12);
    new DataView(p.buffer).setUint32(4, w);
    new DataView(p.buffer).setUint32(8, h);
    return box('ispe', p);
  };
  const ftyp = box('ftyp', Uint8Array.from([...'avif\0\0\0\0mif1avif'].map((c) => c.charCodeAt(0))));
  const data = Uint8Array.from([...ftyp, ...ispe(160, 120), ...ispe(2048, 1536)]);
  assert.deepEqual(parseImageHeader(data), { format: 'AVIF', width: 2048, height: 1536 });
});

test('SVG width/height and viewBox', () => {
  const enc = (s) => new TextEncoder().encode(s);
  assert.deepEqual(parseImageHeader(enc('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" width="640px" height="480">')), { format: 'SVG', width: 640, height: 480 });
  assert.deepEqual(parseImageHeader(enc('<svg viewBox="0 0 24 12">')), { format: 'SVG', width: 24, height: 12 });
});

test('HTML is not an image', () => {
  assert.equal(parseImageHeader(new TextEncoder().encode('<!doctype html><html><body>hi</body></html>')), null);
});
