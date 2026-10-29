// End-to-end test: loads the unpacked extension into Chrome for Testing,
// analyses the local fixture site, drives the viewer, downloads and the paste screen.
//   npm run test:e2e            (set SCREENSHOTS=dir to keep screenshots)
import puppeteer from 'puppeteer';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../fixtures/server.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const extPath = path.join(root, 'extension');
const PORT = Number(process.env.E2E_PORT) || 8765;
const SITE = `http://127.0.0.1:${PORT}`;
const shots = process.env.SCREENSHOTS;

const results = [];
async function step(name, fn) {
  const t = Date.now();
  try {
    await fn();
    results.push({ name, ok: true, ms: Date.now() - t });
    console.log(`  ✔ ${name}`);
  } catch (e) {
    results.push({ name, ok: false, ms: Date.now() - t, error: e.message });
    console.log(`  ✖ ${name}\n      ${e.message.split('\n').join('\n      ')}`);
  }
}

const server = await startServer(PORT);
const profile = mkdtempSync(path.join(tmpdir(), 'ih-profile-'));
const downloadDir = mkdtempSync(path.join(tmpdir(), 'ih-downloads-'));
mkdirSync(path.join(profile, 'Default'), { recursive: true });
writeFileSync(path.join(profile, 'Default', 'Preferences'), JSON.stringify({ download: { default_directory: downloadDir, prompt_for_download: false } }));

const browser = await puppeteer.launch({
  headless: true,
  pipe: true,
  enableExtensions: [extPath],
  userDataDir: profile,
  args: ['--no-sandbox', '--window-size=1400,1000'],
  defaultViewport: { width: 1400, height: 1000 },
});

const swTarget = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().endsWith('/background.js'));
const sw = await swTarget.worker();
const extId = new URL(swTarget.url()).host;

const site = await browser.newPage();
await site.goto(`${SITE}/`, { waitUntil: 'load' });
const [{ id: tabId }] = await sw.evaluate((u) => chrome.tabs.query({ url: u }), `${SITE}/*`);

const app = await browser.newPage();
app.on('pageerror', (e) => console.log('    [app error]', e.message));
await app.goto(`chrome-extension://${extId}/app/app.html?tabId=${tabId}`);

const waitScan = () => app.waitForFunction(() => /더 큰 원본 발견|새로 찾은 이미지가 없습니다/.test(document.querySelector('#scanStatus').textContent), { timeout: 60000 });
const cards = () =>
  app.$$eval('#grid .card', (els) =>
    els.map((el) => ({
      url: el.querySelector('.name').title,
      dims: el.querySelector('.dims').textContent,
      badges: [...el.querySelectorAll('.badge')].map((b) => b.textContent),
    })),
  );
const byPath = (list, p) => list.find((c) => c.url === SITE + p);
const swState = () => app.evaluate(() => chrome.runtime.sendMessage({ type: 'snapshot' }));
const files = (dir) => (existsSync(dir) ? readdirSync(dir).sort() : []);

console.log('Image Hunter E2E');

let list;
await step('collects img / srcset / picture / CSS background / links and removes duplicates', async () => {
  await waitScan();
  list = await cards();
  assert.equal(list.length, 12, `expected 12 images, got ${list.length}: ${list.map((c) => c.url).join(', ')}`);
  for (const p of ['/img/plain-large.png', '/img/bg-hero.png', '/img/dup.png', '/img/no-ext-image']) assert.ok(byPath(list, p), `missing ${p}`);
});

await step('srcset: the largest verified candidate is the original', async () => {
  const a = byPath(list, '/img/sizes/a-1920.png');
  assert.ok(a, 'a-1920 not chosen');
  assert.match(a.dims, /1920 × 1280 · PNG/);
  assert.ok(a.badges.includes('원본 발견'));
  assert.ok(byPath(list, '/img/sizes/b-2x.png'), 'x-descriptor srcset');
  assert.ok(byPath(list, '/img/pic-large.png'), '<picture> source');
  assert.ok(!byPath(list, '/img/sizes/a-480.png'), 'thumbnail size should collapse into the original');
});

await step('thumbnail link and URL variant lead to originals', async () => {
  const cat = byPath(list, '/img/gallery/full/cat.png');
  assert.ok(cat && /3200 × 2400/.test(cat.dims) && cat.badges.includes('링크'), JSON.stringify(cat));
  const wp = byPath(list, '/uploads/photo.png');
  assert.ok(wp && /2700 × 1800/.test(wp.dims) && wp.badges.includes('변형 URL'), JSON.stringify(wp));
});

await step('thumbnails and unverifiable images are flagged', async () => {
  const icon = byPath(list, '/img/icon-thumb.png');
  assert.ok(icon.badges.includes('썸네일 의심'), JSON.stringify(icon));
  const broken = byPath(list, '/img/missing.png');
  assert.ok(broken.badges.includes('원본 후보 없음') && broken.badges.includes('원본 확인 필요'), JSON.stringify(broken));
});

await step('file size shown only when verified, Referer-protected image loads', async () => {
  const plain = byPath(list, '/img/plain-large.png');
  assert.match(plain.dims, /2400 × 1600 · PNG · [\d.]+ (KB|MB)/);
  const prot = byPath(list, '/protected/secret.png');
  assert.match(prot.dims, /1500 × 1000/, 'Referer rule should let the protected image load: ' + prot.dims);
  assert.equal(byPath(list, '/img/missing.png').dims, '해상도 미확인 · PNG');
});

await step('scroll and rescan finds lazy-loaded images, keeps selection', async () => {
  await app.click('#grid .card .pick');
  await app.click('#btnScrollScan');
  await app.waitForFunction(() => document.querySelectorAll('#grid .card').length >= 14, { timeout: 90000 });
  await waitScan();
  list = await cards();
  assert.equal(list.length, 14);
  assert.ok(byPath(list, '/img/lazy-1.png') && byPath(list, '/img/lazy-2.png'));
  assert.match(await app.$eval('#countLine', (e) => e.textContent), /선택 1/);
});

await step('filters: min width, format, exclude thumbnails; sorting', async () => {
  await app.type('#fMinW', '1500');
  await app.waitForFunction(() => /표시 [1-9] \/ 전체 14/.test(document.querySelector('#countLine').textContent));
  let l = await cards();
  assert.ok(l.length > 0 && l.every((c) => Number(c.dims.split(' × ')[0]) >= 1500), l.map((c) => c.dims).join(' | '));
  await app.$eval('#fMinW', (e) => { e.value = ''; e.dispatchEvent(new Event('input')); });
  await app.click('#fNoThumb');
  await new Promise((r) => setTimeout(r, 150));
  l = await cards();
  assert.ok(!l.some((c) => c.badges.includes('썸네일 의심')));
  await app.click('#fNoThumb');
  await app.select('#sortKey', 'area');
  await app.click('#sortDir'); // descending
  await new Promise((r) => setTimeout(r, 150));
  l = await cards();
  assert.equal(l[0].url, SITE + '/img/gallery/full/cat.png');
  await app.select('#sortKey', 'order');
  await app.click('#sortDir');
});

await step('select all / none / filtered only', async () => {
  await app.click('#btnSelectAll');
  await app.waitForFunction(() => /선택 14/.test(document.querySelector('#countLine').textContent));
  await app.click('#btnSelectNone');
  await app.waitForFunction(() => /선택 0/.test(document.querySelector('#countLine').textContent));
  await app.click('#fNoThumb');
  await app.click('#btnSelectFiltered');
  const shown = await app.$$eval('#grid .card', (e) => e.length);
  await app.waitForFunction((n) => new RegExp(`선택 ${n}\\b`).test(document.querySelector('#countLine').textContent), {}, shown);
  await app.click('#fNoThumb');
  await app.click('#btnSelectNone');
});

await step('sequential viewer: buttons, arrow keys, select, thumbnail exclusion', async () => {
  await app.click('#btnViewer');
  await app.waitForSelector('#viewer:not([hidden])');
  const counter = () => app.$eval('#vCounter', (e) => e.textContent);
  assert.equal(await counter(), '이미지 1 / 14');
  await app.waitForFunction(() => !document.querySelector('#vImg').hidden && document.querySelector('#vImg').naturalWidth > 0);
  assert.equal(await app.$eval('#vImg', (e) => e.naturalWidth), 2400, 'viewer shows the original, not the thumbnail');
  await app.keyboard.press('ArrowRight');
  assert.equal(await counter(), '이미지 2 / 14');
  await app.click('#vNext');
  assert.equal(await counter(), '이미지 3 / 14');
  await app.keyboard.press('ArrowLeft');
  assert.equal(await counter(), '이미지 2 / 14');
  await app.keyboard.press(' ');
  assert.equal(await app.$eval('#vSelect', (e) => e.checked), true);
  await app.click('#vNoThumb');
  await app.waitForFunction(() => /\/ 1[0-3]$/.test(document.querySelector('#vCounter').textContent), { timeout: 5000 });
  await app.click('#vNoThumb');
  await app.waitForFunction(() => /\/ 14$/.test(document.querySelector('#vCounter').textContent), { timeout: 5000 });
  if (shots) await app.screenshot({ path: path.join(shots, 'viewer.png') });
});

await step('viewer: failed image shows an error and allows moving on', async () => {
  await app.keyboard.press('End');
  // Walk back to the broken image
  for (let i = 0; i < 14; i++) {
    const name = await app.$eval('#vUrl', (e) => e.textContent);
    if (name.endsWith('/img/missing.png')) break;
    await app.keyboard.press('ArrowLeft');
  }
  await app.waitForSelector('#vError:not([hidden])', { timeout: 10000 });
  const before = await app.$eval('#vCounter', (e) => e.textContent);
  await app.click('#vErrNext');
  assert.notEqual(await app.$eval('#vCounter', (e) => e.textContent), before);
  await app.keyboard.press('Escape');
  assert.equal(await app.$eval('#viewer', (e) => e.hidden), true);
});

const siteDir = path.join(downloadDir, 'Image Hunter', '127.0.0.1');
await step('batch download into Image Hunter/<site>/ with server names, progress and failure reasons', async () => {
  await app.click('#btnSelectAll');
  await app.click('#btnDownload');
  const deadline = Date.now() + 60000;
  let s;
  while (Date.now() < deadline) {
    s = await swState();
    if (s?.items?.length === 14 && s.items.every((i) => ['complete', 'failed', 'cancelled'].includes(i.status))) break;
    await new Promise((r) => setTimeout(r, 300));
  }
  if (process.env.DEBUG) console.log(JSON.stringify(s.items.map((i) => [i.url, i.status, i.error, i.filename]), null, 1));
  const failed = s.items.filter((i) => i.status === 'failed');
  assert.equal(s.items.filter((i) => i.status === 'complete').length, 13, JSON.stringify(failed));
  assert.deepEqual(failed.map((i) => [i.url.replace(SITE, ''), i.error]), [['/img/missing.png', '찾을 수 없음 (404)']]);
  const got = files(siteDir);
  for (const f of ['plain-large.png', 'a-1920.png', 'b-2x.png', 'pic-large.png', 'bg-hero.png', 'cat.png', 'photo.png', 'server-named.png', 'secret.png', 'dup.png', 'lazy-1.png', 'lazy-2.png', 'icon-thumb.png']) {
    assert.ok(got.includes(f), `missing ${f}; got ${got.join(', ')}`);
  }
  assert.ok(!got.some((f) => f.includes('?')));
});

await step('downloads view: states and retry of failed items', async () => {
  await app.click('.tab[data-view="downloads"]');
  await app.waitForFunction(() => /완료 13/.test(document.querySelector('#dlSummary').textContent) && /실패 1/.test(document.querySelector('#dlSummary').textContent));
  const errs = await app.$$eval('#dlTable td.err', (e) => e.map((x) => x.textContent).filter(Boolean));
  assert.deepEqual(errs, ['찾을 수 없음 (404)']);
  if (shots) await app.screenshot({ path: path.join(shots, 'downloads.png') });
  await app.click('#dlRetryFailed');
  await app.waitForFunction(() => /실패 1/.test(document.querySelector('#dlSummary').textContent) && /진행 중 0/.test(document.querySelector('#dlSummary').textContent) && /대기 0/.test(document.querySelector('#dlSummary').textContent), { timeout: 20000 });
});

await step('name collisions never overwrite: second download gets _001', async () => {
  await app.click('.tab[data-view="analyze"]');
  const idx = list.findIndex((c) => c.url === SITE + '/img/gallery/full/cat.png');
  const cardsEl = await app.$$('#grid .card .thumb');
  await cardsEl[idx].click();
  await app.waitForSelector('#viewer:not([hidden])');
  await app.keyboard.press('d');
  await app.keyboard.press('Escape');
  const deadline = Date.now() + 20000;
  while (!files(siteDir).includes('cat_001.png') && Date.now() < deadline) await new Promise((r) => setTimeout(r, 300));
  assert.ok(files(siteDir).includes('cat_001.png'), files(siteDir).join(', '));
});

await step('paste URLs: validation, dedupe, preview check, custom name, page URL detection, download', async () => {
  await app.click('.tab[data-view="paste"]');
  await app.$eval('#pasteText', (e, s) => {
    e.value = [
      `${s}/img/sizes/a-960.png`,
      `${s}/img/sizes/a-960.png#dup`,
      `${s}/img/dup.png  내가정한이름`,
      `${s}/webtoon/1`,
      `${s}/img/nothing-here.png`,
      'ftp://x/y.png',
    ].join('\n');
  }, SITE);
  await app.type('#pasteFolder', '붙여넣기');
  await app.click('#btnPasteParse');
  assert.match(await app.$eval('#pasteSummary', (e) => e.textContent), /유효한 URL 4개 · 중복 제거 1개 · 형식 오류 1개/);
  await app.waitForFunction(() => ![...document.querySelectorAll('#pasteTable td')].some((td) => td.textContent === '확인 중…'), { timeout: 20000 });
  const rows = await app.$$eval('#pasteTable tbody tr', (trs) => trs.map((tr) => tr.children[3].textContent));
  assert.match(rows[0], /✓ 다운로드 가능 · 960×640 · PNG/);
  assert.match(rows[2], /웹페이지 주소입니다/);
  assert.match(rows[3], /찾을 수 없음 \(404\)/);
  if (shots) await app.screenshot({ path: path.join(shots, 'paste.png') });
  await app.click('#pasteDlSel');
  const dir = path.join(downloadDir, 'Image Hunter', '127.0.0.1', '붙여넣기');
  const deadline = Date.now() + 20000;
  while (files(dir).length < 2 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 300));
  assert.deepEqual(files(dir), ['a-960.png', '내가정한이름.png']);
  await app.waitForFunction(() => /실패 1/.test(document.querySelector('#pasteCount').textContent), { timeout: 20000 });
});

await step('failed URL list export', async () => {
  await app.click('#pasteExport');
  await new Promise((r) => setTimeout(r, 1500));
  if (process.env.DEBUG) console.log('toast:', await app.$eval('#toast', (e) => e.textContent), JSON.stringify(await app.evaluate(async () => (await chrome.downloads.search({ orderBy: ['-startTime'], limit: 2 })).map((d) => [d.url.slice(0, 40), d.filename, d.state, d.error]))));
  const deadline = Date.now() + 10000;
  const dir = path.join(downloadDir, 'Image Hunter');
  while (!files(dir).some((f) => f.startsWith('failed_urls_')) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 300));
  assert.ok(files(dir).some((f) => f.startsWith('failed_urls_')), files(dir).join(', '));
});

if (shots) {
  await app.click('.tab[data-view="analyze"]');
  await app.screenshot({ path: path.join(shots, 'analyze.png') });
}

await browser.close();
server.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (process.env.E2E_REPORT) writeFileSync(process.env.E2E_REPORT, JSON.stringify(results, null, 2));
process.exit(failed.length ? 1 : 0);
