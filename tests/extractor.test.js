// Runs the real page collector (content/collector.js) inside headless Chrome
// against small fixture pages. Skipped when Chrome for Testing is not installed.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { collectImages, autoScroll } from '../extension/content/collector.js';
import { mergeOrder, dedupeInOrder } from '../extension/lib/ordering.js';
import { startServer, setPage } from './fixtures/server.mjs';

const PORT = Number(process.env.EXTRACTOR_PORT) || 8781;
const SITE = `http://127.0.0.1:${PORT}`;
let browser;
let server;
let page;
let skip = false;

before(async () => {
  try {
    const { default: puppeteer } = await import('puppeteer');
    browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
  } catch (e) {
    skip = `Chrome를 실행할 수 없어 건너뜀: ${e.message.split('\n')[0]}`;
    return;
  }
  server = await startServer(PORT);
  page = await browser.newPage();
});
after(async () => {
  await browser?.close();
  server?.close();
});

async function collect(path, html) {
  if (html) setPage(path, html);
  await page.goto(SITE + path, { waitUntil: 'load' });
  return page.evaluate(collectImages, {});
}
const rel = (u) => (u || '').replace(SITE, '');
const doc = (body, head = '') => `<!doctype html><html><head><meta charset="utf-8">${head}</head><body>${body}</body></html>`;

test('img, CSS backgrounds (several per element) and links are interleaved in DOM order', async (t) => {
  if (skip) return t.skip(skip);
  const r = await collect('/x/order', doc(`
    <div style="width:50px;height:50px;background:url('/a.png')"></div>
    <img src="/b.png">
    <div style="width:50px;height:50px;background-image:url('/c.png'), url('/d.png')"></div>
    <a href="/e.jpg">link</a>
    <a href="/page.html">not an image</a>
    <img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" data-src="/f.png">`));
  assert.deepEqual(r.entries.map((e) => rel(e.displayUrl)), ['/a.png', '/b.png', '/c.png', '/d.png', '/e.jpg', '/f.png']);
  assert.deepEqual(r.entries.map((e) => e.elementType), ['css', 'img', 'css', 'css', 'a', 'img']);
});

test('srcset, sizes, data-src, data-srcset, data-original and image links are candidates', async (t) => {
  if (skip) return t.skip(skip);
  const r = await collect('/x/cands', doc(`
    <a href="/full/one.jpg"><img id="one" src="/s/one.jpg" srcset="/s/one.jpg 400w, /m/one.jpg 800w" sizes="(max-width: 600px) 100vw, 400px"></a>
    <img data-srcset="/l1.jpg 1x, /l2.jpg 2x" data-original="/orig.jpg" src="/placeholder.gif">
    <img src="https://cdn.test/w_300,h_200,c_fill/x.jpg" srcset="https://cdn.test/w_300,h_200/x.jpg 300w, https://cdn.test/w_900,h_600/x.jpg 900w">`));
  const [one, lazy, cdn] = r.entries;
  assert.deepEqual(one.candidates.map((c) => [rel(c.url), c.kind]), [
    ['/s/one.jpg', 'src'], ['/s/one.jpg', 'srcset'], ['/m/one.jpg', 'srcset'], ['/full/one.jpg', 'link'],
  ]);
  assert.equal(one.sizes, '(max-width: 600px) 100vw, 400px');
  assert.equal(one.candidates[2].w, 800);
  assert.deepEqual(lazy.candidates.map((c) => [rel(c.url), c.kind, c.attr]).slice(1), [
    ['/l1.jpg', 'srcset', 'data-srcset'], ['/l2.jpg', 'srcset', 'data-srcset'], ['/orig.jpg', 'lazy', 'data-original'],
  ]);
  // Commas inside CDN URLs don't break srcset parsing
  assert.deepEqual(cdn.candidates.filter((c) => c.kind === 'srcset').map((c) => c.url), ['https://cdn.test/w_300,h_200/x.jpg', 'https://cdn.test/w_900,h_600/x.jpg']);
});

test('other data-* attributes are used only when they hold an image URL', async (t) => {
  if (skip) return t.skip(skip);
  const r = await collect('/x/data', doc(`<img src="/t.jpg" data-hd="/big/t.jpg" data-page="/article/12" data-id="12345" data-json='{"a":1}' data-cdn="https://x.test/p.webp?v=2" data-js="javascript:alert(1)">`));
  const extra = r.entries[0].candidates.filter((c) => c.kind === 'hires').map((c) => [c.attr, rel(c.url)]);
  assert.deepEqual(extra, [['data-hd', '/big/t.jpg'], ['data-cdn', 'https://x.test/p.webp?v=2']]);
});

test('invalid, unsafe and blob URLs become entries with an error instead of stopping the scan', async (t) => {
  if (skip) return t.skip(skip);
  const r = await collect('/x/bad', doc(`
    <img src="http://[bad">
    <img src="javascript:alert(1)">
    <img id="blob">
    <img src="/ok.png">
    <script>
      const c = document.createElement('canvas'); c.width = c.height = 4;
      document.getElementById('blob').src = URL.createObjectURL(new Blob([new Uint8Array(8)], { type: 'image/png' }));
    </script>`));
  assert.deepEqual(r.entries.map((e) => [e.urlKind, !!e.urlError]), [['invalid', true], ['unsafe', true], ['blob', true], ['http', false]]);
  assert.equal(r.entries[0].candidates.length, 0);
});

test('stable element ids across rescans, and the page DOM is not modified', async (t) => {
  if (skip) return t.skip(skip);
  setPage('/x/stable', doc('<img id="a" src="/a.png"><img id="b" src="/b.png"><div id="slot"></div><img id="c" src="/c.png">'));
  await page.goto(`${SITE}/x/stable`, { waitUntil: 'load' });
  const before = await page.evaluate(() => document.documentElement.outerHTML);
  const r1 = await page.evaluate(collectImages, {});
  assert.equal(await page.evaluate(() => document.documentElement.outerHTML), before, 'no attributes or nodes added');
  // A new image appears between b and c (dynamic loading).
  await page.evaluate(() => {
    const i = document.createElement('img');
    i.src = '/new.png';
    document.getElementById('slot').append(i);
  });
  const r2 = await page.evaluate(collectImages, {});
  assert.equal(r1.docId, r2.docId);
  const k1 = r1.entries.map((e) => e.key);
  const k2 = r2.entries.map((e) => e.key);
  assert.deepEqual(k2.filter((k) => k1.includes(k)), k1, 'existing elements keep their ids');
  const merged = mergeOrder(k1, k2);
  const urlOf = new Map(r2.entries.map((e) => [e.key, rel(e.displayUrl)]));
  assert.deepEqual(merged.map((k) => urlOf.get(k)), ['/a.png', '/b.png', '/new.png', '/c.png'], 'new image inserted at its DOM position');
  // Navigation = new document = new docId (lists of different pages never mix)
  await page.goto(`${SITE}/x/stable?again`, { waitUntil: 'load' });
  const r3 = await page.evaluate(collectImages, {});
  assert.notEqual(r3.docId, r1.docId);
});

test('duplicate URLs are all found; the first occurrence represents them', async (t) => {
  if (skip) return t.skip(skip);
  const r = await collect('/x/dup', doc('<img src="/d.png"><img src="/e.png"><img src="/d.png"><img src="/d.png#x">'));
  assert.equal(r.entries.length, 4);
  const { unique } = dedupeInOrder(r.entries, (e) => e.displayUrl.split('#')[0]);
  assert.deepEqual(unique.map((e) => rel(e.displayUrl)), ['/d.png', '/e.png']);
});

test('open shadow DOM images are found at their host position', async (t) => {
  if (skip) return t.skip(skip);
  const r = await collect('/x/shadow', doc(`<img src="/1.png"><div id="host"></div><img src="/3.png">
    <script>document.getElementById('host').attachShadow({ mode: 'open' }).innerHTML = '<img src="/2.png">';</script>`));
  assert.deepEqual(r.entries.map((e) => rel(e.displayUrl)), ['/1.png', '/2.png', '/3.png']);
});

test('auto-scroll is bounded and restores the user scroll position', async (t) => {
  if (skip) return t.skip(skip);
  setPage('/x/tall', doc('<div style="height:20000px">tall</div>'));
  await page.goto(`${SITE}/x/tall`, { waitUntil: 'load' });
  await page.evaluate(() => window.scrollTo(0, 1234));
  const r = await page.evaluate(autoScroll, { maxScreens: 3, stepDelay: 30 });
  assert.equal(r.screens, 3);
  assert.equal(r.reachedEnd, false);
  assert.equal(await page.evaluate(() => window.scrollY), 1234);
});
