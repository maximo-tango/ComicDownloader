// End-to-end test: loads the extension into Chrome for Testing and drives the
// real UI against the local fixture site. Numbers in [] refer to the test list
// in docs/TEST_REPORT.md.
//
//   npm run test:e2e        (E2E_PORT=…, SCREENSHOTS=dir, E2E_REPORT=file.json)
//
// Puppeteer cannot click the toolbar button, so it cannot trigger the activeTab
// grant. The test therefore loads a copy of the extension whose manifest also
// grants http://127.0.0.1/* — the same access activeTab gives for that page.
// http://localhost:<port> stays without permission, to test that path.
import puppeteer from 'puppeteer';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer, setFile } from '../fixtures/server.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = Number(process.env.E2E_PORT) || 8765;
const SITE = `http://127.0.0.1:${PORT}`;
const OTHER = `http://localhost:${PORT}`; // a second origin the extension has no permission for
const shots = process.env.SCREENSHOTS;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
async function step(name, fn) {
  const t = Date.now();
  try {
    const note = await fn();
    results.push({ name, ok: true, ms: Date.now() - t, note: note || '' });
    console.log(`  ✔ ${name}${note ? ` — ${note}` : ''}`);
  } catch (e) {
    results.push({ name, ok: false, ms: Date.now() - t, error: e.message });
    console.log(`  ✖ ${name}\n      ${e.message.split('\n').join('\n      ')}`);
  }
}

// ---- setup ---------------------------------------------------------------
const server = await startServer(PORT);
const tmp = mkdtempSync(path.join(tmpdir(), 'ih-e2e-'));
const extPath = path.join(tmp, 'extension');
cpSync(path.join(root, 'extension'), extPath, { recursive: true });
const manifest = JSON.parse(readFileSync(path.join(extPath, 'manifest.json'), 'utf8'));
manifest.host_permissions = ['http://127.0.0.1/*'];
writeFileSync(path.join(extPath, 'manifest.json'), JSON.stringify(manifest, null, 2));

const profile = path.join(tmp, 'profile');
const downloadDir = path.join(tmp, 'downloads');
mkdirSync(path.join(profile, 'Default'), { recursive: true });
mkdirSync(downloadDir);
writeFileSync(path.join(profile, 'Default', 'Preferences'), JSON.stringify({ download: { default_directory: downloadDir, prompt_for_download: false } }));

const browser = await puppeteer.launch({
  headless: true,
  pipe: true,
  enableExtensions: [extPath],
  userDataDir: profile,
  args: ['--no-sandbox', '--window-size=1400,1000'],
  defaultViewport: { width: 1400, height: 1000 },
});
const findWorker = () => browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().endsWith('/background.js'));
let swTarget = await findWorker();
const extId = new URL(swTarget.url()).host;
// The steps below check every format and thumbnail; the shipped defaults
// (JPG only, thumbnails hidden, scroll on open) get their own step at the end.
const ALL_FILTERS = { filterNoThumb: false, filterFormats: null, scrollOnOpen: false, filterMinWidth: 0, filterMinHeight: 0 };
// Written from an extension page: right after start-up the worker may not have its APIs yet.
const setupPage = await browser.newPage();
await setupPage.goto(`chrome-extension://${extId}/options/options.html`);
await setupPage.evaluate((s) => chrome.storage.local.set({ settings: s }), ALL_FILTERS);
await setupPage.close();
const consoleErrors = [];

async function openSite(p) {
  const page = await browser.newPage();
  await page.goto(SITE + p, { waitUntil: 'load' });
  const sw = await swTarget.worker();
  const tabs = await sw.evaluate((u) => chrome.tabs.query({ url: u }), SITE + p.split('?')[0] + '*');
  return { page, tabId: tabs[tabs.length - 1].id };
}
async function openApp(query) {
  const app = await browser.newPage();
  app.on('pageerror', (e) => consoleErrors.push(e.message));
  // Chrome logs refused network requests itself; the fixture deliberately has refusing
  // origins (404, 403, no-permission localhost). Only script errors count here.
  app.on('console', (m) => m.type() === 'error' && !/Failed to load resource|blocked by CORS policy: No 'Access-Control-Allow-Origin'/.test(m.text()) && consoleErrors.push(m.text()));
  await app.goto(`chrome-extension://${extId}/app/app.html?${query}`);
  return app;
}
const waitScan = (app, timeout = 60000) =>
  app.waitForFunction(() => /새로 발견/.test(document.querySelector('#scanStatus').textContent), { timeout });
const cards = (app) =>
  app.$$eval('#grid .card', (els) =>
    els.map((el) => ({
      id: el.dataset.id,
      seq: el.querySelector('.seq').textContent,
      url: el.querySelector('.name a')?.href || el.querySelector('.name').textContent,
      dims: el.querySelector('.dims').textContent,
      sub: el.querySelector('.sub').textContent,
      badges: [...el.querySelectorAll('.badge')].map((b) => b.textContent),
      checked: el.querySelector('.pick').checked,
      disabled: el.querySelector('.pick').disabled,
    })),
  );
const byPath = (list, p) => list.find((c) => c.url === SITE + p);
const countLine = (app) => app.$eval('#countLine', (e) => e.textContent);
const snapshot = (page) =>
  Promise.race([
    page.evaluate(() => chrome.runtime.sendMessage({ type: 'snapshot' }).then((r) => r.jobs)),
    sleep(5000).then(() => {
      throw new Error('snapshot timed out');
    }),
  ]);
const files = (dir) => (existsSync(dir) ? readdirSync(dir).filter((f) => !f.endsWith('.crdownload')).sort() : []);
async function until(fn, timeout = 30000, label = 'condition') {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    last = await fn();
    if (last) return last;
    await sleep(200);
  }
  throw new Error(`timed out waiting for ${label}`);
}
const settled = (jobs) => jobs.every((j) => ['success', 'failed', 'cancelled'].includes(j.status));

console.log('Image Hunter E2E');

// ===========================================================================
const main = await openSite('/');
const app = await openApp(`tabId=${main.tabId}`);
const MAIN_DIR = path.join(downloadDir, 'ImageHunter', 'Image Hunter 테스트 페이지');
let list;

await step('[1][2][3][4][5][7] img·srcset·data-src·CSS 배경·이미지 링크 수집, 같은 URL 중복 제거', async () => {
  await waitScan(app);
  list = await cards(app);
  const paths = list.map((c) => c.url.replace(SITE, ''));
  for (const p of ['/img/plain-large.png', '/img/sizes/a-1920.png', '/img/bg-hero.png', '/img/gallery/full/cat.png', '/img/lazy-data-src.png', '/img/hd/data-hd.png', '/img/dup.png']) {
    assert.ok(paths.includes(p), `missing ${p}`);
  }
  assert.equal(paths.filter((p) => p === '/img/dup.png').length, 1, 'dup.png ×3 → 1');
  assert.equal(paths.filter((p) => p === '/img/plain-large.png').length, 1, 'og:image = plain-large → merged');
  assert.equal(list.length, 17, paths.join(', '));
  assert.match(await countLine(app), /같은 URL 3개는 첫 항목으로 합침/);
  return `${list.length}개`;
});

await step('목록 항목 정보: 순번·해상도·종횡비·확장자·크기·원본 상태', async () => {
  const a = byPath(list, '/img/sizes/a-1920.png');
  assert.equal(a.dims, '1920 × 1280 · 3:2');
  assert.match(a.sub, /^PNG · [\d.]+ KB$/);
  assert.ok(a.badges.includes('고해상도 후보') && a.badges.includes('srcset'), a.badges.join());
  assert.deepEqual(list.map((c) => c.seq), list.map((_, i) => `#${i + 1}`));
  const plain = byPath(list, '/img/plain-large.png');
  assert.ok(plain.badges.includes('원본 후보 확인'), plain.badges.join());
});

await step('[8] 썸네일과 다른 URL의 원본: 링크·data-hd 속성으로 찾음, URL 패턴 추측은 기본 꺼짐', async () => {
  const cat = byPath(list, '/img/gallery/full/cat.png');
  assert.equal(cat.dims, '3200 × 2400 · 4:3');
  assert.ok(cat.badges.includes('고해상도 후보') && cat.badges.includes('링크'));
  const hd = byPath(list, '/img/hd/data-hd.png');
  assert.match(hd.dims, /^2000 × 1500/);
  const wp = byPath(list, '/uploads/photo-300x200.png');
  assert.ok(wp, 'without guessing, the WordPress thumbnail stays as is');
  assert.ok(wp.badges.includes('후보 비교 필요') && wp.badges.includes('썸네일 의심'), wp.badges.join());
});

await step('[9][10] 접근할 수 없는 이미지와 잘못된 URL은 오류 상태로 표시, 나머지는 계속 처리', async () => {
  // The page itself displayed it, so its size is known; the URL itself is refused to the extension.
  const prot = byPath(list, '/protected/secret.png');
  assert.equal(prot.dims, '1500 × 1000 · 3:2');
  assert.ok(prot.badges.includes('확인 불가'), prot.badges.join());
  const missing = byPath(list, '/img/missing.png');
  assert.ok(missing.badges.includes('확인 불가'));
  const broken = list.filter((c) => c.disabled);
  assert.equal(broken.length, 3, 'invalid, javascript:, blob:');
  assert.deepEqual(broken.map((c) => c.badges[0]).sort(), ['blob URL', '잘못된 URL', '잘못된 URL']);
  assert.ok(broken.every((c) => c.dims === '다운로드 불가'));
});

await step('후보 선택 UI: 항목의 다운로드 URL을 바꿔도 순서·선택 유지', async () => {
  await app.bringToFront(); // background tabs don't run requestAnimationFrame
  const idx = list.findIndex((c) => c.url.endsWith('/a-1920.png'));
  await app.click(`#grid .card:nth-child(${idx + 1}) .pick`);
  await app.select(`#grid .card:nth-child(${idx + 1}) .cand`, `${SITE}/img/sizes/a-480.png`);
  await app.waitForFunction((i) => document.querySelector(`#grid .card:nth-child(${i}) .dims`).textContent.startsWith('480 × 320'), {}, idx + 1);
  let now = await cards(app);
  assert.equal(now[idx].id, list[idx].id);
  assert.ok(now[idx].checked);
  assert.ok(now[idx].badges.some((b) => b.includes('(직접 선택)')));
  await app.select(`#grid .card:nth-child(${idx + 1}) .cand`, `${SITE}/img/sizes/a-1920.png`);
  await app.click(`#grid .card:nth-child(${idx + 1}) .pick`);
  now = await cards(app);
  assert.match(now[idx].dims, /^1920/);
});

await step('[15][16] 모두 선택·모두 해제·표시된 항목만 선택, 숨겨진 선택 유지', async () => {
  await app.bringToFront(); // background tabs don't run requestAnimationFrame
  await app.click('#btnSelectAll');
  await app.waitForFunction(() => /선택 14개/.test(document.querySelector('#countLine').textContent)); // 17 - 3 broken
  await app.click('#btnSelectNone');
  await app.waitForFunction(() => /선택 0개/.test(document.querySelector('#countLine').textContent));
  const c = await cards(app);
  await app.click(`#grid .card:nth-child(1) .pick`);
  await app.click(`#grid .card:nth-child(3) .pick`);
  await app.click('#fNoThumb');
  await app.waitForFunction(() => /선택 2개/.test(document.querySelector('#countLine').textContent));
  await app.click('#btnSelectVisible');
  const shown = (await cards(app)).filter((x) => !x.disabled).length;
  await app.waitForFunction((n) => new RegExp(`선택 ${n}개`).test(document.querySelector('#countLine').textContent), {}, shown);
  await app.click('#fNoThumb');
  await app.click('#btnSelectNone');
  return `표시 항목 ${shown}개 선택 (${c.length - shown}개 숨김/불가)`;
});

await step('[6] 스크롤하며 추가 검색: 지연 로딩 이미지가 페이지 위치에 추가', async () => {
  await app.bringToFront(); // background tabs don't run requestAnimationFrame
  await app.click('#grid .card:nth-child(2) .pick');
  await app.click('#btnScrollScan');
  await app.waitForFunction(() => /새로 발견 2개/.test(document.querySelector('#scanStatus').textContent), { timeout: 90000 });
  list = await cards(app);
  assert.equal(list.length, 19);
  assert.deepEqual(list.slice(-2).map((c) => c.url.replace(SITE, '')), ['/img/lazy-1.png', '/img/lazy-2.png']);
  assert.ok(list[1].checked, 'selection kept');
  await app.click('#grid .card:nth-child(2) .pick');
});

// ===========================================================================
const ord = await openSite('/order');
const oapp = await openApp(`tabId=${ord.tabId}`);
const ORDER_DIR = path.join(downloadDir, 'ImageHunter', '순서 테스트');
let olist;

await step('[11][12] DOM 순서 유지: 파일명 알파벳·해상도 순서와 다름, CSS 배경 섞임', async () => {
  await waitScan(oapp);
  olist = await cards(oapp);
  assert.deepEqual(olist.map((c) => c.url.replace(SITE, '/')), ['//order/zebra-1200.png', '//order/bg-mid.png', '//order/apple.png', '//order/mango.png']);
  assert.deepEqual(olist.map((c) => c.seq), ['#1', '#2', '#3', '#4']);
});

await step('[13] 미리보기 크기 변경: 순서·URL·선택·필터 그대로', async () => {
  await oapp.bringToFront(); // background tabs don't run requestAnimationFrame
  await oapp.click('#grid .card:nth-child(3) .pick');
  const before = await cards(oapp);
  for (const size of ['small', 'large', 'medium']) {
    await oapp.click(`.segmented button[data-size="${size}"]`);
    await sleep(100);
    assert.ok(await oapp.$eval('#grid', (g, s) => g.classList.contains(`size-${s}`), size));
    const after = await cards(oapp);
    assert.deepEqual(after.map((c) => [c.id, c.url, c.checked, c.dims]), before.map((c) => [c.id, c.url, c.checked, c.dims]));
  }
  const stored = await oapp.evaluate(() => chrome.storage.local.get('settings').then((r) => r.settings.previewSize));
  assert.equal(stored, 'medium');
});

await step('[14] 해상도 필터 후 상대 순서 유지, 숨겨진 선택 보존', async () => {
  await oapp.bringToFront(); // background tabs don't run requestAnimationFrame
  await oapp.type('#fMinW', '700');
  await oapp.waitForFunction(() => /표시 3개/.test(document.querySelector('#countLine').textContent));
  const f = await cards(oapp);
  assert.deepEqual(f.map((c) => c.seq), ['#1', '#2', '#4']);
  assert.match(await countLine(oapp), /선택 0개 \(필터로 숨겨진 선택 1개는 보관만 하고 다운로드·PDF에서 제외\)/);
  await oapp.type('#fMinW', '-'); // "700-" → invalid
  await oapp.$eval('#fMinW', (e) => { e.value = '-5'; e.dispatchEvent(new Event('input')); });
  await oapp.waitForFunction(() => /0 이상/.test(document.querySelector('#filterError').textContent));
  await oapp.$eval('#fMinW', (e) => { e.value = ''; e.dispatchEvent(new Event('input')); });
  await oapp.waitForFunction(() => /표시 4개/.test(document.querySelector('#countLine').textContent));
});

await step('[17] 재검색: 새 요소는 DOM 위치에 삽입, 기존 순서·선택 유지', async () => {
  await oapp.bringToFront(); // background tabs don't run requestAnimationFrame
  await ord.page.evaluate(() => {
    const i = document.createElement('img');
    i.src = '/order/kiwi.png';
    document.getElementById('slot').append(i);
  });
  await oapp.click('#btnScan');
  await oapp.waitForFunction(() => /새로 발견 1개/.test(document.querySelector('#scanStatus').textContent));
  const after = await cards(oapp);
  assert.deepEqual(after.map((c) => c.url.replace(`${SITE}/order/`, '')), ['zebra-1200.png', 'bg-mid.png', 'apple.png', 'kiwi.png', 'mango.png']);
  assert.ok(after[2].checked, 'apple still selected');
  assert.deepEqual(after.map((c) => c.id).filter((id) => olist.some((o) => o.id === id)), olist.map((o) => o.id));
});

await step('PDF로 저장: 선택 순서(페이지 순서) 그대로 한 파일', async () => {
  await oapp.bringToFront(); // background tabs don't run requestAnimationFrame
  await oapp.click('#btnSelectAll');
  await oapp.click('#btnPdf');
  await oapp.waitForFunction(() => /PDF 저장: 5장 포함/.test(document.querySelector('#pdfStatus').textContent), { timeout: 60000 });
  const pdfPath = path.join(ORDER_DIR, '순서 테스트.pdf');
  await until(() => existsSync(pdfPath), 20000, 'pdf file');
  const text = readFileSync(pdfPath).toString('latin1');
  assert.ok(text.startsWith('%PDF-1.4'));
  // continuous layout: all five joined on one page (total height 5300pt < 14400pt)
  assert.equal((text.match(/\/Type \/Page /g) || []).length, 1);
  const widths = [...text.matchAll(/\/Subtype \/Image \/Width (\d+)/g)].map((m) => Number(m[1]));
  assert.deepEqual(widths, [1200, 900, 600, 700, 4000]);
  await oapp.click('#btnSelectNone');
  return `${(readFileSync(pdfPath).length / 1024).toFixed(0)} KB`;
});

// ===========================================================================
await step('필터로 숨겨진 선택은 PDF·다운로드에서 제외', async () => {
  await oapp.bringToFront(); // background tabs don't run requestAnimationFrame
  await oapp.click('#btnSelectAll');
  await oapp.type('#fMinW', '700'); // hides apple (600) and kiwi (700 → shown) … leaves zebra, bg, kiwi, mango
  await oapp.waitForFunction(() => /필터로 숨겨진 선택 1개는 보관만 하고/.test(document.querySelector('#countLine').textContent));
  assert.match(await oapp.$eval('#btnPdf', (b) => b.textContent), /PDF로 저장 \(4\)/);
  await oapp.click('#btnPdf');
  await oapp.waitForFunction(() => /PDF 저장: 4장 포함/.test(document.querySelector('#pdfStatus').textContent), { timeout: 60000 });
  const pdfPath = path.join(ORDER_DIR, '순서 테스트 (1).pdf');
  await until(() => existsSync(pdfPath), 20000, 'second pdf');
  const widths = [...readFileSync(pdfPath).toString('latin1').matchAll(/\/Subtype \/Image \/Width (\d+)/g)].map((m) => Number(m[1]));
  assert.deepEqual(widths, [1200, 900, 700, 4000], 'apple (hidden by the filter) is not in the PDF');
  await oapp.$eval('#fMinW', (e) => { e.value = ''; e.dispatchEvent(new Event('input')); });
  await oapp.click('#btnSelectNone');
});

await step('[19][23] 일괄 다운로드: ImageHunter/페이지 제목/ 폴더, 서버 파일명, 진행 상태', async () => {
  await app.bringToFront(); // background tabs don't run requestAnimationFrame
  await app.click('#btnSelectAll');
  await app.click('#btnDownload');
  const jobs = await until(async () => {
    const j = await snapshot(app);
    return j.length >= 16 && settled(j) && j;
  }, 60000, 'downloads');
  const ok = jobs.filter((j) => j.status === 'success');
  const failed = jobs.filter((j) => j.status === 'failed');
  assert.equal(ok.length, 14, JSON.stringify(failed.map((j) => [j.url, j.error])));
  const got = files(MAIN_DIR);
  for (const f of ['plain-large.png', 'a-1920.png', 'b-2x.png', 'pic-large.png', 'bg-hero.png', 'cat.png', 'photo-300x200.png', 'icon-thumb.png', 'server-named.png', 'dup.png', 'lazy-data-src.png', 'data-hd.png', 'lazy-1.png', 'lazy-2.png']) {
    assert.ok(got.includes(f), `missing ${f}; got ${got.join(', ')}`);
  }
  assert.ok(jobs.every((j) => j.source === 'page' && j.itemKey));
  const c = await cards(app);
  assert.ok(byPath(c, '/img/plain-large.png').badges.includes('다운로드 완료'));
});

await step('[9] 핫링크 방지·없는 이미지: 우회하지 않고 실패 사유 표시', async () => {
  const jobs = await snapshot(app);
  const f = Object.fromEntries(jobs.filter((j) => j.status === 'failed').map((j) => [j.url.replace(SITE, ''), j.error]));
  assert.deepEqual(f, {
    '/protected/secret.png': '접근 거부 (403) — 사이트가 외부 다운로드를 막았을 수 있음',
    '/img/missing.png': '서버가 파일을 제공하지 않음 (404 등)',
  });
  const c = await cards(app);
  assert.ok(byPath(c, '/protected/secret.png').badges.includes('다운로드 실패'));
});

await step('[21] 실패 항목만 재시도, 성공 항목은 다시 받지 않음', async () => {
  await app.bringToFront(); // background tabs don't run requestAnimationFrame
  const before = await snapshot(app);
  await app.click('#btnDownload'); // same selection again
  await app.waitForFunction(() => /실패·취소했던 2개 다시 시도, 이미 받았거나 진행 중인 14개 제외/.test(document.querySelector('#toast').textContent));
  let jobs = await until(async () => {
    const j = await snapshot(app);
    return settled(j) && j.filter((x) => x.attempts === 2).length === 2 && j;
  }, 20000, 're-selected failed items retried');
  assert.equal(jobs.length, before.length, 're-selecting failed items retried them; no duplicate jobs');
  await app.click('.tab[data-view="downloads"]');
  await app.click('#dlRetryFailed');
  jobs = await until(async () => {
    const j = await snapshot(app);
    return settled(j) && j.filter((x) => x.attempts === 3).length === 2 && j;
  }, 20000, 'retry failed');
  assert.ok(jobs.filter((j) => j.status === 'success').every((j) => j.attempts === 1), 'successful files not downloaded twice');
  assert.equal(jobs.filter((j) => j.status === 'failed').length, 2);
  if (shots) await app.screenshot({ path: path.join(shots, 'downloads.png') });
});

await step('[24] 다운로드 결과 CSV·JSON 내보내기', async () => {
  await app.bringToFront(); // background tabs don't run requestAnimationFrame
  await app.click('#dlExportCsv');
  await app.click('#dlExportJson');
  const dir = path.join(downloadDir, 'ImageHunter');
  const csv = await until(() => files(dir).find((f) => /^download_result_.*\.csv$/.test(f)), 10000, 'csv').catch(async (e) => {
    const recent = await app.evaluate(() => chrome.downloads.search({ orderBy: ['-startTime'], limit: 3 }).then((l) => l.map((d) => [d.state, d.error, d.danger, d.filename.split('/').slice(-2).join('/')])));
    throw new Error(`${e.message}; toast="${await app.$eval('#toast', (t) => t.textContent)}"; recent=${JSON.stringify(recent)}`);
  });
  const json = await until(() => files(dir).find((f) => /^download_result_.*\.json$/.test(f)), 10000, 'json');
  const csvText = readFileSync(path.join(dir, csv), 'utf8');
  assert.ok(csvText.startsWith('﻿원본 URL,다운로드 URL,파일명'));
  const data = JSON.parse(readFileSync(path.join(dir, json), 'utf8'));
  const jobs = await snapshot(app);
  assert.equal(data.length, jobs.length);
  assert.ok(data.some((r) => r.status === 'failed' && /403/.test(r.error)));
  assert.ok(data.filter((r) => r.status === 'success').every((r) => r.filename.startsWith('ImageHunter/Image Hunter 테스트 페이지/') && r.finishedAt));
  return `${csv}, ${json}`;
});

// ===========================================================================
// A real JPEG for the PDF pass-through check, made by the browser.
const jpegB64 = await app.evaluate(async () => {
  const c = new OffscreenCanvas(320, 240);
  const g = c.getContext('2d');
  g.fillStyle = '#c33';
  g.fillRect(0, 0, 320, 240);
  g.fillStyle = '#3c3';
  g.fillRect(40, 40, 120, 80);
  const b = await c.convertToBlob({ type: 'image/jpeg', quality: 0.9 });
  const bytes = new Uint8Array(await b.arrayBuffer());
  let s = '';
  for (const x of bytes) s += String.fromCharCode(x);
  return btoa(s);
});
const jpegBytes = Buffer.from(jpegB64, 'base64');
setFile('/files/photo.jpg', jpegBytes, 'image/jpeg');

await step('[25][26] URL 직접 입력: 입력 순서 유지, 잘못된 URL 목록, 중복 제거', async () => {
  await app.bringToFront(); // background tabs don't run requestAnimationFrame
  await app.click('.tab[data-view="paste"]');
  await app.$eval('#pasteText', (e, s) => {
    e.value = [`${s}/order/zebra-400.png`, `${s}/order/apple.png  사과`, `${s}/order/zebra-400.png#dup`, 'not a url', 'ftp://x/y.png', `${s}/order/mango.png`].join('\n');
  }, SITE);
  await app.$eval('#pasteFolder', (e) => (e.value = '입력순서'));
  await app.click('#btnPasteParse');
  assert.match(await app.$eval('#pasteSummary', (e) => e.textContent), /유효한 URL 3개 · 중복 제거 1개 · 잘못된 URL 2개/);
  const invalid = await app.$$eval('#pasteInvalid li', (l) => l.map((x) => x.textContent));
  assert.deepEqual(invalid.map((t) => t.split(':')[0]), ['4번째 줄', '5번째 줄']);
  const rows = await app.$$eval('#pasteTable tbody tr', (trs) => trs.map((tr) => tr.children[3].textContent));
  assert.deepEqual(rows.map((u) => u.split('/').pop()), ['zebra-400.png', 'apple.png', 'mango.png']);
  await app.waitForFunction(() => ![...document.querySelectorAll('#pasteTable td')].some((td) => td.textContent === '확인 중…'), { timeout: 20000 });
  await app.click('#pasteDlAll');
  const dir = path.join(downloadDir, 'ImageHunter', '입력순서');
  await until(() => files(dir).length === 3, 20000, 'paste files');
  // the custom name "사과" (given after the URL) wins and gets the verified extension
  assert.deepEqual(files(dir), ['mango.png', 'zebra-400.png', '사과.png']);
  const jobs = (await snapshot(app)).filter((j) => j.source === 'paste');
  assert.deepEqual(jobs.map((j) => j.url.split('/').pop()), ['zebra-400.png', 'apple.png', 'mango.png'], 'queued in input order');
  assert.equal(jobs[1].filename, 'ImageHunter/입력순서/사과.png');
});

await step('[20] 파일명 충돌: 다른 URL의 같은 이름 → "이름 (1)"로 모두 저장', async () => {
  await app.bringToFront(); // background tabs don't run requestAnimationFrame
  await app.$eval('#pasteText', (e, s) => (e.value = [`${s}/img/dup.png`, `${s}/cors/img/dup.png`, `${s}/img/dup.png?v=2`].join('\n')), SITE);
  await app.$eval('#pasteFolder', (e) => (e.value = '충돌'));
  await app.click('#btnPasteParse');
  await app.waitForFunction(() => ![...document.querySelectorAll('#pasteTable td')].some((td) => td.textContent === '확인 중…'), { timeout: 20000 });
  await app.click('#pasteDlAll');
  const dir = path.join(downloadDir, 'ImageHunter', '충돌');
  await until(() => files(dir).length === 3, 20000, 'collision files');
  assert.deepEqual(files(dir), ['dup (1).png', 'dup (2).png', 'dup.png']);
});

await step('TXT/CSV 불러오기와 다른 사이트(권한 없음) 이미지 처리', async () => {
  await app.bringToFront(); // background tabs don't run requestAnimationFrame
  const csvPath = path.join(tmp, 'list.csv');
  writeFileSync(csvPath, `﻿url,filename\r\n${SITE}/img/sizes/b-1x.png,첫번째\r\n"${OTHER}/img/plain-large.png",\r\n`);
  await app.$eval('#pasteText', (e) => (e.value = ''));
  const input = await app.$('#pasteImport');
  await input.uploadFile(csvPath);
  await app.waitForFunction(() => /유효한 URL 2개/.test(document.querySelector('#pasteSummary').textContent));
  assert.equal(await app.$eval('#pasteText', (e) => e.value.split('\n')[0].split('  ')[1]), '첫번째');
  await app.waitForFunction(() => ![...document.querySelectorAll('#pasteTable td')].some((td) => td.textContent === '확인 중…'), { timeout: 20000 });
  const res = await app.$$eval('#pasteTable tbody tr', (trs) => trs.map((tr) => tr.children[4].textContent));
  // Without permission for localhost the size cannot be read, so it is not shown.
  assert.match(res[1], /2400×1600 \(3:2\) · PNG \(추정\) · 크기 확인 불가/);
  assert.match(res[0], /600×400 \(3:2\) · PNG · [\d.]+ KB/);
});

await step('URL 목록의 PDF: JPEG는 그대로, 읽을 수 없는 이미지는 사유와 함께 제외', async () => {
  await app.bringToFront(); // background tabs don't run requestAnimationFrame
  await app.$eval('#pasteText', (e, [s, o]) => (e.value = [`${s}/files/photo.jpg`, `${s}/order/apple.png`, `${o}/img/plain-large.png`, `${o}/cors/img/dup.png`].join('\n')), [SITE, OTHER]);
  await app.$eval('#pasteFolder', (e) => (e.value = 'PDF테스트'));
  await app.click('#btnPasteParse');
  await app.waitForFunction(() => ![...document.querySelectorAll('#pasteTable td')].some((td) => td.textContent === '확인 중…'), { timeout: 20000 });
  await app.click('#pastePdf');
  await app.waitForFunction(() => /PDF (저장|를 만들지)/.test(document.querySelector('#pasteSummary').textContent), { timeout: 30000 });
  const summary = await app.$eval('#pasteSummary', (e) => e.textContent);
  assert.match(summary, /^PDF 저장: 3장 → ImageHunter\/PDF테스트\/PDF테스트\.pdf/, summary);
  assert.match(summary, /3번\(이미지 데이터를 읽을 권한이 없음/);
  const pdfPath = path.join(downloadDir, 'ImageHunter', 'PDF테스트', 'PDF테스트.pdf');
  await until(() => existsSync(pdfPath), 10000, 'pdf');
  const buf = readFileSync(pdfPath);
  const text = buf.toString('latin1');
  const imgs = [...text.matchAll(/\/Width (\d+) \/Height (\d+) \/ColorSpace \/\w+ \/BitsPerComponent 8 \/Filter \/(\w+) \/Length (\d+) >>\nstream\n/g)];
  assert.deepEqual(imgs.map((m) => [Number(m[1]), m[3]]), [[320, 'DCTDecode'], [600, 'FlateDecode'], [900, 'FlateDecode']]);
  const start = imgs[0].index + imgs[0][0].length;
  assert.ok(buf.subarray(start, start + Number(imgs[0][4])).equals(jpegBytes), 'JPEG embedded byte-for-byte');
});

await step('[22] 다운로드 취소', async () => {
  await app.bringToFront(); // background tabs don't run requestAnimationFrame
  await app.$eval('#pasteText', (e, s) => (e.value = `${s}/slow/big.png?cancel`), SITE);
  await app.$eval('#pasteFolder', (e) => (e.value = '취소'));
  await app.click('#btnPasteParse');
  await app.waitForFunction(() => ![...document.querySelectorAll('#pasteTable td')].some((td) => td.textContent === '확인 중…'), { timeout: 20000 });
  await app.click('#pasteDlAll');
  const job = await until(async () => (await snapshot(app)).find((j) => j.url.endsWith('?cancel') && j.status === 'downloading' && j.downloadId != null), 10000, 'downloading');
  await app.evaluate((id) => chrome.runtime.sendMessage({ type: 'cancel', ids: [id] }), job.id);
  const done = await until(async () => (await snapshot(app)).find((j) => j.id === job.id && j.status === 'cancelled'), 10000, 'cancelled');
  await sleep(1500);
  const again = (await snapshot(app)).find((j) => j.id === job.id);
  assert.equal(again.status, 'cancelled', 'a late Chrome event must not change a cancelled job');
  assert.deepEqual(files(path.join(downloadDir, 'ImageHunter', '취소')), []);
  return `${done.bytesReceived} bytes 받은 상태에서 취소`;
});

await step('[28] 서비스 워커 재시작: 진행 중 다운로드 상태를 복구해 끝까지 추적', async () => {
  await app.bringToFront(); // background tabs don't run requestAnimationFrame
  await app.$eval('#pasteText', (e, s) => (e.value = `${s}/slow/big.png?restart`), SITE);
  await app.$eval('#pasteFolder', (e) => (e.value = '재시작'));
  await app.click('#btnPasteParse');
  await app.waitForFunction(() => ![...document.querySelectorAll('#pasteTable td')].some((td) => td.textContent === '확인 중…'), { timeout: 20000 });
  await app.click('#pasteDlAll');
  const job = await until(async () => (await snapshot(app)).find((j) => j.url.endsWith('?restart') && j.status === 'downloading' && j.downloadId != null), 10000, 'downloading');
  await sleep(700); // let the worker persist its state
  const worker = await swTarget.worker();
  await worker.close(); // stops the service worker like Chrome does when idle
  await sleep(300);
  // Any extension event restarts it; the app page reconnects on its own.
  const done = await until(async () => (await snapshot(app).catch(() => [])).find((j) => j.id === job.id && j.status === 'success'), 30000, 'success after restart');
  swTarget = await findWorker();
  assert.ok(files(path.join(downloadDir, 'ImageHunter', '재시작')).includes('big.png'));
  await app.click('.tab[data-view="downloads"]');
  await app.waitForFunction((id) => document.querySelector(`#dlTable tr[data-job="${id}"] .st`)?.textContent === '완료', {}, job.id);
  return `job ${done.id}: attempts=${done.attempts}`;
});

await step('[27] 다운로드 중 원본 탭 이동: 다운로드는 계속, 재검색 시 다른 페이지 목록과 섞이지 않음', async () => {
  await oapp.bringToFront(); // background tabs don't run requestAnimationFrame
  await oapp.click('#btnSelectNone');
  // Add the slow image to the order page and download it from there.
  await ord.page.evaluate(() => {
    const i = document.createElement('img');
    i.src = '/slow/big.png?nav';
    document.body.append(i);
  });
  await oapp.click('#btnScan');
  await oapp.waitForFunction(() => /새로 발견 1개/.test(document.querySelector('#scanStatus').textContent), { timeout: 30000 });
  const last = (await cards(oapp)).at(-1);
  assert.match(last.url, /slow\/big\.png\?nav$/);
  await oapp.click('#grid .card:last-child .pick');
  await oapp.click('#btnDownload');
  await until(async () => (await snapshot(oapp)).find((j) => j.url.endsWith('?nav') && j.status === 'downloading'), 10000, 'downloading');
  await ord.page.goto(`${SITE}/webtoon/1`, { waitUntil: 'load' }); // navigate the source tab
  const job = await until(async () => (await snapshot(oapp)).find((j) => j.url.endsWith('?nav') && ['success', 'failed'].includes(j.status)), 30000, 'nav download');
  assert.equal(job.status, 'success');
  await oapp.click('#btnScan');
  await oapp.waitForFunction(() => /페이지가 바뀌어 목록을 새로 만들었습니다/.test(document.querySelector('#scanStatus').textContent), { timeout: 20000 });
  const fresh = await cards(oapp);
  assert.deepEqual(fresh.map((c) => c.url.replace(SITE, '')), ['/img/lazy-1.png', '/img/lazy-2.png']);
  assert.match(await oapp.$eval('#pageTitle', (e) => e.textContent), /Episode/);
});

// ===========================================================================
await step('[18] 이미지 1000장 페이지 성능', async () => {
  const many = await openSite('/many?n=1000');
  const t0 = Date.now();
  const mapp = await openApp(`tabId=${many.tabId}`);
  await waitScan(mapp, 180000);
  const tScan = Date.now() - t0;
  const n = await mapp.$$eval('#grid .card', (e) => e.length);
  assert.equal(n, 1000);
  const seqs = await mapp.$$eval('#grid .card', (e) => [e[0], e[499], e[999]].map((x) => x.querySelector('.seq').textContent + ' ' + x.querySelector('img').getAttribute('src').split('/').pop()));
  assert.deepEqual(seqs, ['#1 0.png', '#500 499.png', '#1000 999.png']);
  // Responsiveness: select all + filter + preview size change.
  const t1 = Date.now();
  await mapp.click('#btnSelectAll');
  await mapp.waitForFunction(() => /선택 1000개/.test(document.querySelector('#countLine').textContent));
  await mapp.type('#fMinW', '200');
  await mapp.waitForFunction(() => !/표시 1000개/.test(document.querySelector('#countLine').textContent));
  await mapp.click('.segmented button[data-size="small"]');
  await mapp.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const tUi = Date.now() - t1;
  assert.ok(tScan < 120000, `scan took ${tScan} ms`);
  assert.ok(tUi < 5000, `UI took ${tUi} ms`);
  await mapp.click('.segmented button[data-size="medium"]');
  await mapp.close();
  await many.page.close();
  return `검색+판별 ${(tScan / 1000).toFixed(1)}초, 전체 선택·필터·크기 변경 ${tUi} ms`;
});

await step('연속 PDF: 주소의 번호를 바꿔 각 페이지를 열고 스크롤·필터 후 PDF로 저장', async () => {
  await app.bringToFront(); // background tabs don't run requestAnimationFrame
  await app.click('.tab[data-view="batch"]');
  await app.$eval('#bUrl', (e, u) => { e.value = u; e.dispatchEvent(new Event('input')); }, `${SITE}/ep?series=7&no=1`);
  assert.equal(await app.$eval('#bParam', (s) => s.value), 'q:no', 'episode-like parameter preselected');
  await app.$eval('#bEnd', (e) => { e.value = '4'; e.dispatchEvent(new Event('input')); });
  assert.match(await app.$eval('#bPreview', (e) => e.textContent), /^4개 주소: .*no=1 … .*no=4$/);
  // fixtures are PNG; the requested size filter: width ≥ 500, height ≥ 400
  await app.$eval('#bJpg', (e) => (e.checked = false));
  await app.$eval('#bMinW', (e) => (e.value = '500'));
  await app.$eval('#bMinH', (e) => (e.value = '400'));
  await app.$eval('#bDelay', (e) => (e.value = '0'));
  await app.$eval('#bFolder', (e) => (e.value = '연속'));
  await app.click('#bRun');
  await app.waitForFunction(() => /완료 3 · 건너뜀 1 · 실패 0 · 남음 0/.test(document.querySelector('#bSummary').textContent), { timeout: 120000 });
  const rows = await app.$$eval('#bTable tbody tr', (trs) => trs.map((tr) => [...tr.children].map((td) => td.textContent)));
  assert.deepEqual(rows.map((r) => [r[0], r[2], r[3]]), [['1', '완료', '3장 / 찾은 4장'], ['2', '완료', '3장 / 찾은 4장'], ['3', '완료', '3장 / 찾은 4장'], ['4', '건너뜀', '0장 / 찾은 0장']]);
  const dir = path.join(downloadDir, 'ImageHunter', '연속');
  await until(() => files(dir).length === 3, 20000, 'batch pdfs');
  assert.deepEqual(files(dir), ['에피소드 1.pdf', '에피소드 2.pdf', '에피소드 3.pdf']);
  const text = readFileSync(path.join(dir, '에피소드 2.pdf')).toString('latin1');
  const imgs = [...text.matchAll(/\/Subtype \/Image \/Width (\d+) \/Height (\d+)/g)].map((m) => `${m[1]}x${m[2]}`);
  assert.deepEqual(imgs, ['690x950', '690x900', '690x850'], 'strips in page order, scrolled-in strip included, banner filtered out');
  assert.equal((text.match(/\/Type \/Page /g) || []).length, 1, 'joined without gaps');
  const left = await (await swTarget.worker()).evaluate((u) => chrome.tabs.query({ url: u }).then((t) => t.length), `${SITE}/ep*`);
  assert.equal(left, 0, 'opened tabs are closed again');
});

await step('기본 설정: JPG만·썸네일 의심 제외·처음 검색 때 스크롤', async () => {
  await (await swTarget.worker()).evaluate(() => chrome.storage.local.remove('settings'));
  const site2 = await openSite('/?defaults');
  const dapp = await openApp(`tabId=${site2.tabId}`);
  await dapp.bringToFront();
  await waitScan(dapp, 90000);
  const status = await dapp.$eval('#scanStatus', (e) => e.textContent);
  assert.match(status, /화면까지 확인함|페이지 끝까지 확인함/, 'first search scrolled the page: ' + status);
  assert.match(status, /이미지 19개/, 'lazy images found on the first search');
  assert.equal(await dapp.$eval('#fNoThumb', (e) => e.checked), true);
  const on = await dapp.$$eval('#fFormats .chip.on', (l) => l.map((c) => c.textContent));
  assert.deepEqual(on, ['JPG']);
  assert.deepEqual(await dapp.$$eval('#fMinW, #fMinH', (l) => l.map((i) => i.value)), ['500', '400']);
  // the batch view starts from the same defaults
  assert.deepEqual(await dapp.$$eval('#bMinW, #bMinH', (l) => l.map((i) => i.value)), ['500', '400']);
  assert.equal(await dapp.$eval('#bJpg', (e) => e.checked), true);
  await dapp.close();
  await site2.page.close();
  await (await swTarget.worker()).evaluate((s) => chrome.storage.local.set({ settings: s }), ALL_FILTERS);
});

await step('팝업·설정 화면 동작 및 콘솔 오류 없음', async () => {
  await app.bringToFront(); // background tabs don't run requestAnimationFrame
  const popup = await browser.newPage();
  popup.on('pageerror', (e) => consoleErrors.push('popup: ' + e.message));
  await popup.goto(`chrome-extension://${extId}/popup/popup.html`);
  // Opened as a tab here, so "current tab" is the popup itself: analysis must be disabled.
  assert.equal(await popup.$eval('#analyze', (b) => b.disabled), true);
  await popup.close();
  const opt = await browser.newPage();
  opt.on('pageerror', (e) => consoleErrors.push('options: ' + e.message));
  await opt.goto(`chrome-extension://${extId}/options/options.html`);
  await opt.select('select[name="folderMode"]', 'site');
  await opt.waitForFunction(() => /저장되었습니다/.test(document.querySelector('#saved').textContent));
  const s = await opt.evaluate(() => chrome.storage.local.get('settings').then((r) => r.settings));
  assert.equal(s.folderMode, 'site');
  await opt.select('select[name="folderMode"]', 'page');
  assert.match(await opt.$eval('#permState', (e) => e.textContent), /메뉴를 연 탭에만 접근/);
  await opt.close();
  assert.deepEqual(consoleErrors, []);
});

if (shots) {
  try {
    await app.bringToFront();
    await app.click('.tab[data-view="analyze"]');
    await app.screenshot({ path: path.join(shots, 'analyze.png') });
    await oapp.bringToFront();
    await oapp.screenshot({ path: path.join(shots, 'order.png') });
  } catch (e) {
    console.log('  (screenshots skipped:', e.message.split('\n')[0] + ')');
  }
}

await browser.close();
server.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (process.env.E2E_REPORT) writeFileSync(process.env.E2E_REPORT, JSON.stringify(results, null, 2));
process.exit(failed.length ? 1 : 0);
