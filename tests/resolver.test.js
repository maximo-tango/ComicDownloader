import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCandidates, chooseOriginal, resolveEntry, selectCandidate } from '../extension/lib/resolver.js';

const GUESS = { thumbMaxSide: 300, maxVariants: 6, guessVariants: true };

// Probe stub: url -> { width, height } (missing = failed request)
const probeFrom = (table) => async (url) => {
  const t = table[url];
  return t ? { ok: true, format: 'JPEG', bytes: t.bytes ?? null, ...t } : { ok: false, error: '찾을 수 없음 (404)' };
};

const entry = (over) => ({
  order: 0, elementType: 'img', pageUrl: 'https://site.test/page', rendered: { w: 200, h: 150 }, natural: { w: 200, h: 150 },
  ...over,
});

test('largest srcset candidate wins over the small src', async () => {
  const e = entry({
    displayUrl: 'https://site.test/a-400.jpg',
    candidates: [
      { url: 'https://site.test/a-400.jpg', kind: 'src' },
      { url: 'https://site.test/a-400.jpg', kind: 'srcset', w: 400 },
      { url: 'https://site.test/a-1600.jpg', kind: 'srcset', w: 1600 },
    ],
  });
  const item = await resolveEntry(e, probeFrom({
    'https://site.test/a-400.jpg': { width: 400, height: 300 },
    'https://site.test/a-1600.jpg': { width: 1600, height: 1200 },
  }));
  assert.equal(item.originalUrl, 'https://site.test/a-1600.jpg');
  assert.equal(item.sourceType, 'srcset');
  assert.equal(item.originalStatus, 'found');
  assert.equal(item.confidenceLabel, '높음');
  assert.equal(item.originalState, 'hires');
  assert.equal(item.isThumbnail, false);
  assert.deepEqual([item.width, item.height], [1600, 1200]);
});

test('srcset "largest" is checked against real size: a bigger link wins', async () => {
  const e = entry({
    displayUrl: 'https://site.test/p/1.jpg',
    candidates: [
      { url: 'https://site.test/p/1.jpg', kind: 'src' },
      { url: 'https://site.test/p/1-2x.jpg', kind: 'srcset', x: 2 },
      { url: 'https://site.test/full/1.jpg', kind: 'link' },
    ],
  });
  const item = await resolveEntry(e, probeFrom({
    'https://site.test/p/1.jpg': { width: 200, height: 150 },
    'https://site.test/p/1-2x.jpg': { width: 400, height: 300 },
    'https://site.test/full/1.jpg': { width: 4000, height: 3000 },
  }));
  assert.equal(item.originalUrl, 'https://site.test/full/1.jpg');
  assert.equal(item.sourceType, 'link');
});

test('linked image with a different shape is not adopted', async () => {
  const e = entry({
    displayUrl: 'https://site.test/t/cat.jpg',
    candidates: [
      { url: 'https://site.test/t/cat.jpg', kind: 'src' },
      { url: 'https://site.test/banner.jpg', kind: 'link' },
    ],
  });
  const item = await resolveEntry(e, probeFrom({
    'https://site.test/t/cat.jpg': { width: 200, height: 150 },
    'https://site.test/banner.jpg': { width: 3000, height: 300 },
  }));
  assert.equal(item.originalUrl, 'https://site.test/t/cat.jpg');
  assert.equal(item.isThumbnail, true, 'only a 200px image is left: thumbnail suspected');
  assert.equal(item.originalState, 'compare', 'a larger but differently shaped image exists: user should compare');
});

test('URL-pattern guessing is off by default', async () => {
  const e = entry({ displayUrl: 'https://site.test/up/photo-300x225.jpg', natural: { w: 300, h: 225 }, candidates: [{ url: 'https://site.test/up/photo-300x225.jpg', kind: 'src' }] });
  const seen = [];
  const item = await resolveEntry(e, async (u) => (seen.push(u), { ok: true, width: 300, height: 225 }));
  assert.deepEqual(seen, ['https://site.test/up/photo-300x225.jpg']);
  assert.equal(item.originalUrl, 'https://site.test/up/photo-300x225.jpg');
});

test('verified URL variant replaces a WordPress thumbnail (option on)', async () => {
  const e = entry({
    displayUrl: 'https://site.test/up/photo-300x225.jpg',
    natural: { w: 300, h: 225 },
    candidates: [{ url: 'https://site.test/up/photo-300x225.jpg', kind: 'src' }],
  });
  const item = await resolveEntry(e, probeFrom({
    'https://site.test/up/photo-300x225.jpg': { width: 300, height: 225 },
    'https://site.test/up/photo.jpg': { width: 2400, height: 1800 },
  }), GUESS);
  assert.equal(item.originalUrl, 'https://site.test/up/photo.jpg');
  assert.equal(item.sourceType, 'variant');
  assert.equal(item.originalStatus, 'found');
  const chosen = item.candidates.find((c) => c.chosen);
  assert.equal(chosen.rule, 'suffix');
});

test('a guessed variant that does not exist is ignored', async () => {
  const e = entry({
    displayUrl: 'https://site.test/thumbs/dog.jpg',
    natural: { w: 1200, h: 900 },
    rendered: { w: 300, h: 225 },
    candidates: [{ url: 'https://site.test/thumbs/dog.jpg', kind: 'src' }],
  });
  const item = await resolveEntry(e, probeFrom({ 'https://site.test/thumbs/dog.jpg': { width: 1200, height: 900 } }), GUESS);
  assert.equal(item.originalUrl, 'https://site.test/thumbs/dog.jpg');
  assert.equal(item.originalStatus, 'self');
  assert.ok(item.candidates.some((c) => c.kind === 'variant' && !c.ok));
  assert.equal(item.isThumbnail, true, 'URL says "thumbs" and nothing larger was found');
});

test('unverifiable images are marked 확인 필요 / 원본 후보 없음', async () => {
  const e = entry({ displayUrl: 'https://site.test/x.jpg', natural: null, rendered: { w: 800, h: 600 }, candidates: [{ url: 'https://site.test/x.jpg', kind: 'css' }] });
  const item = await resolveEntry(e, probeFrom({}));
  assert.equal(item.originalStatus, 'none');
  assert.equal(item.originalState, 'unknown');
  assert.equal(item.confidenceLabel, '확인 필요');
  assert.equal(item.width, 0);
});

test('plain large image shown downscaled is high confidence', async () => {
  const e = entry({ displayUrl: 'https://site.test/big.jpg', natural: { w: 3000, h: 2000 }, rendered: { w: 600, h: 400 }, candidates: [{ url: 'https://site.test/big.jpg', kind: 'src' }] });
  const item = await resolveEntry(e, probeFrom({ 'https://site.test/big.jpg': { width: 3000, height: 2000, bytes: 123456 } }));
  assert.equal(item.confidenceLabel, '높음');
  assert.equal(item.originalState, 'confirmed');
  assert.equal(item.bytes, 123456);
  assert.equal(item.isThumbnail, false);
});

test('buildCandidates de-duplicates and keeps the most trusted kind', () => {
  const c = buildCandidates(entry({
    displayUrl: 'https://site.test/a.jpg',
    candidates: [
      { url: 'https://site.test/a.jpg', kind: 'src' },
      { url: 'https://site.test/a.jpg#x', kind: 'srcset', w: 800 },
    ],
  }));
  assert.equal(c.length, 1);
  assert.equal(c[0].kind, 'srcset');
});

test('the user can switch to another candidate', async () => {
  const e = entry({
    displayUrl: 'https://site.test/a.jpg',
    candidates: [
      { url: 'https://site.test/a.jpg', kind: 'src' },
      { url: 'https://site.test/a-big.jpg', kind: 'srcset', w: 1600 },
    ],
  });
  const item = await resolveEntry(e, probeFrom({
    'https://site.test/a.jpg': { width: 200, height: 150, bytes: 10 },
    'https://site.test/a-big.jpg': { width: 1600, height: 1200, bytes: 999 },
  }));
  assert.equal(item.originalUrl, 'https://site.test/a-big.jpg');
  const upd = selectCandidate(item, 'https://site.test/a.jpg');
  assert.deepEqual([upd.originalUrl, upd.width, upd.bytes, upd.userChosen], ['https://site.test/a.jpg', 200, 10, true]);
  assert.equal(upd.candidates.filter((c) => c.chosen).length, 1);
  assert.equal(selectCandidate(item, 'https://elsewhere/x.jpg'), null);
});

test('chooseOriginal prefers higher-priority source on equal size', () => {
  const e = entry({ displayUrl: 'https://s/a.jpg' });
  const r = chooseOriginal(e, [
    { url: 'https://s/a.jpg', kind: 'src', probe: { ok: true, width: 800, height: 600 } },
    { url: 'https://s/a2.jpg', kind: 'srcset', probe: { ok: true, width: 800, height: 600 } },
  ]);
  assert.equal(r.sourceType, 'srcset');
});

test('size known from the page but URL unreachable: state is 확인 불가', async () => {
  const e = entry({ displayUrl: 'https://site.test/p.jpg', natural: { w: 1500, h: 1000 }, rendered: { w: 300, h: 200 }, candidates: [{ url: 'https://site.test/p.jpg', kind: 'src' }] });
  const item = await resolveEntry(e, async () => ({ ok: false, error: '접근 거부 (403)' }));
  assert.deepEqual([item.width, item.height, item.originalState], [1500, 1000, 'unknown']);
});
