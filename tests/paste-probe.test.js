import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseUrlList } from '../extension/lib/paste.js';
import { createProber, readHead } from '../extension/lib/probe.js';
import { fakeFetch, jpegHeader, pngHeader } from './helpers.js';

test('URL list: validation, duplicates, custom names, comments', () => {
  const r = parseUrlList([
    'https://a.com/1.jpg',
    '',
    '# comment',
    'https://a.com/2.png   표지 이미지.png',
    'https://a.com/1.jpg#again',
    'ftp://a.com/3.jpg',
    'not a url',
    '  https://newtoki1.org/webtoon/821597/1311912  ',
  ].join('\r\n'));
  assert.deepEqual(r.valid.map((v) => [v.url, v.customName]), [
    ['https://a.com/1.jpg', ''],
    ['https://a.com/2.png', '표지 이미지.png'],
    ['https://newtoki1.org/webtoon/821597/1311912', ''],
  ]);
  assert.equal(r.duplicates, 1);
  assert.deepEqual(r.invalid.map((x) => x.reason), ['HTTP/HTTPS 주소만 지원', 'URL 형식이 아님']);
});

test('readHead: partial content gives dimensions and the full file size', async () => {
  const f = fakeFetch({ 'https://a.com/x.jpg': { body: jpegHeader(2000, 1000), total: 845_000 } });
  const r = await readHead('https://a.com/x.jpg', f);
  assert.equal(r.ok, true);
  assert.deepEqual([r.format, r.width, r.height, r.bytes], ['JPEG', 2000, 1000, 845_000]);
  assert.equal(f.calls[0].init.headers.Range, 'bytes=0-131071');
});

test('readHead: HTML pages are rejected as not-an-image', async () => {
  const f = fakeFetch({ 'https://a.com/page': { body: '<html></html>', type: 'text/html; charset=utf-8' } });
  const r = await readHead('https://a.com/page', f);
  assert.equal(r.ok, false);
  assert.equal(r.isPage, true);
});

test('readHead: HTTP errors are explained', async () => {
  const f = fakeFetch({});
  const r = await readHead('https://a.com/missing.jpg', f);
  assert.deepEqual([r.ok, r.error], [false, '찾을 수 없음 (404)']);
});

test('readHead: data URLs', async () => {
  const b64 = Buffer.from(pngHeader(10, 20)).toString('base64');
  const r = await readHead(`data:image/png;base64,${b64}`);
  assert.deepEqual([r.ok, r.format, r.width, r.height], [true, 'PNG', 10, 20]);
});

test('prober memoises and falls back to decoding when fetch fails', async () => {
  const f = fakeFetch({ 'https://a.com/blocked.jpg': { throws: 'Failed to fetch' } });
  let decodes = 0;
  const probe = createProber({ fetchImpl: f, decode: async () => (decodes++, { width: 640, height: 480 }) });
  const [a, b] = await Promise.all([probe('https://a.com/blocked.jpg'), probe('https://a.com/blocked.jpg')]);
  assert.equal(a, b);
  assert.deepEqual([a.ok, a.width, a.bytes, a.viaDecode], [true, 640, null, true]);
  assert.equal(decodes, 1);
  assert.equal(f.calls.length, 1);
});
