// "연속 PDF" view: open a series of pages (one number in the URL changes),
// scroll each to load its images, keep the ones matching the size filter and
// save one PDF per page. Pages are processed one at a time.

import { $, h, toast } from './common.js';
import { createPdf, savePdf } from './pdf-export.js';
import { collectImages, autoScroll, readImageInPage } from '../content/collector.js';
import { createProber, decodeWithImage, hostAccessPolicy, setCredentialPolicy } from '../lib/probe.js';
import { resolveEntry } from '../lib/resolver.js';
import { applyFilters, DEFAULT_FILTERS } from '../lib/filters.js';
import { dedupeInOrder } from '../lib/ordering.js';
import { urlKey } from '../lib/url-utils.js';
import { buildFolder, sanitizeFilename } from '../lib/filename.js';
import { buildSeries, findNumericParams } from '../lib/batch.js';

const STEP = {
  waiting: '대기', opening: '페이지 여는 중', scrolling: '스크롤하며 이미지 불러오는 중', analyzing: '원본 확인 중',
  pdf: 'PDF 만드는 중', done: '완료', skipped: '건너뜀', failed: '실패', stopped: '중지됨', permission: '권한 필요',
};

export function initBatchView({ getSettings }) {
  let params = [];
  let rows = [];
  let running = false;
  let stop = false;
  const tbody = $('#bTable tbody');

  // ---- form ---------------------------------------------------------------
  const s0 = getSettings();
  $('#bMinW').value = s0.filterMinWidth ?? 500;
  $('#bMinH').value = s0.filterMinHeight ?? 400;
  $('#bJpg').checked = Array.isArray(s0.filterFormats) && s0.filterFormats.includes('JPEG');
  $('#bNoThumb').checked = s0.filterNoThumb !== false;
  $('#bScroll').checked = true;
  $('#bLayout').value = s0.pdfLayout || 'continuous';

  function readUrl() {
    params = findNumericParams($('#bUrl').value.trim());
    const sel = $('#bParam');
    sel.replaceChildren(...(params.length ? params.map((p) => h('option', { value: p.id }, p.label)) : [h('option', { value: '' }, '주소에서 숫자를 찾지 못했습니다')]));
    if (params[0]) {
      $('#bStart').value = Number(params[0].value);
      $('#bEnd').value = Number(params[0].value);
    }
    preview();
  }
  function currentParam() {
    return params.find((p) => p.id === $('#bParam').value);
  }
  function series() {
    const p = currentParam();
    if (!p) throw new Error('바꿀 부분을 고르세요.');
    return buildSeries($('#bUrl').value.trim(), p, $('#bStart').value, $('#bEnd').value, $('#bStep').value || 1);
  }
  function preview() {
    try {
      const list = series();
      $('#bPreview').textContent = `${list.length}개 주소: ${list[0].url}${list.length > 1 ? ` … ${list.at(-1).url}` : ''}`;
      $('#bPreview').classList.remove('error');
    } catch (e) {
      $('#bPreview').textContent = $('#bUrl').value.trim() ? e.message : '';
      $('#bPreview').classList.add('error');
    }
  }
  $('#bUrl').addEventListener('input', readUrl);
  $('#bParam').addEventListener('change', () => {
    const p = currentParam();
    if (p) $('#bStart').value = $('#bEnd').value = Number(p.value);
    preview();
  });
  for (const id of ['bStart', 'bEnd', 'bStep']) $('#' + id).addEventListener('input', preview);

  // ---- table --------------------------------------------------------------
  function renderRow(r) {
    r.tr.replaceChildren(
      h('td', {}, String(r.n)),
      h('td', { class: 'url', title: r.url }, r.title || r.url),
      h('td', {}, h('span', { class: `st ${r.step === 'done' ? 'success' : r.step === 'failed' ? 'failed' : r.step === 'skipped' || r.step === 'stopped' ? 'cancelled' : 'downloading'}` }, STEP[r.step])),
      h('td', {}, r.images == null ? '' : `${r.images}장${r.found != null ? ` / 찾은 ${r.found}장` : ''}`),
      h('td', { class: 'url', title: r.file || '' }, r.file ? r.file.split('/').pop() : ''),
      h('td', { class: 'err' }, r.error || ''),
    );
  }
  const set = (r, patch) => {
    Object.assign(r, patch);
    renderRow(r);
    summary();
  };
  function summary() {
    const c = (st) => rows.filter((r) => r.step === st).length;
    $('#bSummary').textContent = rows.length ? `전체 ${rows.length} · 완료 ${c('done')} · 건너뜀 ${c('skipped')} · 실패 ${c('failed')} · 남음 ${c('waiting')}` : '';
  }

  // ---- run ----------------------------------------------------------------
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  function openTab(url) {
    return new Promise((resolve, reject) => {
      let tabId;
      const timer = setTimeout(() => done(new Error('페이지를 45초 안에 열지 못했습니다')), 45000);
      const onUpdated = (id, info) => {
        if (id === tabId && info.status === 'complete') done(null);
      };
      const done = (err) => {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(onUpdated);
        err ? reject(err) : resolve(tabId);
      };
      chrome.tabs.onUpdated.addListener(onUpdated);
      chrome.tabs.create({ url, active: false }).then((t) => (tabId = t.id), done);
    });
  }

  async function scrollInTab(tabId, maxScreens) {
    // Background tabs don't render, so lazy loaders never fire: show the page while scrolling.
    const me = await chrome.tabs.getCurrent();
    await chrome.tabs.update(tabId, { active: true });
    try {
      const [{ result }] = await chrome.scripting.executeScript({ target: { tabId }, func: autoScroll, args: [{ maxScreens }] });
      return result;
    } finally {
      await chrome.tabs.update(me.id, { active: true }).catch(() => {});
    }
  }

  async function analyze(tabId, probe, filters) {
    const settings = getSettings();
    const [{ result }] = await chrome.scripting.executeScript({ target: { tabId }, func: collectImages, args: [{}] });
    const entries = result.entries.filter((e) => !e.urlError).map((e) => ({ ...e, pageUrl: result.pageUrl }));
    const opts = { thumbMaxSide: settings.thumbMaxSide, maxVariants: 6, guessVariants: settings.guessVariants };
    const resolved = await Promise.all(entries.map((e) => resolveEntry(e, probe, opts)));
    const { unique } = dedupeInOrder(resolved, (it) => urlKey(it.originalUrl));
    return { title: result.title, pageUrl: result.pageUrl, found: unique.length, items: applyFilters(unique, filters).items };
  }

  function currentFilters() {
    const num = (id) => Math.max(0, Math.min(100000, Number($('#' + id).value) || 0));
    return {
      ...DEFAULT_FILTERS,
      minWidth: num('bMinW'),
      minHeight: num('bMinH'),
      formats: $('#bJpg').checked ? ['JPEG'] : null,
      excludeThumbnails: $('#bNoThumb').checked,
    };
  }

  /** Asks (with a click) for access to the image servers a page needs, then resolves. */
  function askForImageHosts(origins) {
    return new Promise((resolve) => {
      const box = $('#bPermission');
      box.hidden = false;
      $('#bPermissionText').textContent = `이 페이지의 이미지는 다른 서버(${origins.map((o) => new URL(o).host).join(', ')})에 있어 PDF에 넣으려면 접근 허용이 필요합니다.`;
      $('#bGrant').onclick = async () => {
        const ok = await chrome.permissions.request({ origins: origins.map((o) => `${o}/*`) }).catch(() => false);
        box.hidden = true;
        resolve(ok);
      };
      $('#bSkipGrant').onclick = () => {
        box.hidden = true;
        resolve(false);
      };
    });
  }

  async function processRow(r, ctx) {
    const settings = getSettings();
    let tabId = null;
    try {
      set(r, { step: 'opening', error: '' });
      tabId = await openTab(r.url);
      await wait(800);
      if (stop) return set(r, { step: 'stopped' });
      if ($('#bScroll').checked) {
        set(r, { step: 'scrolling' });
        await scrollInTab(tabId, settings.scrollMaxScreens);
      }
      set(r, { step: 'analyzing' });
      const a = await analyze(tabId, ctx.probe, ctx.filters);
      set(r, { title: a.title, found: a.found, images: a.items.length });
      if (!a.items.length) return set(r, { step: 'skipped', error: '조건에 맞는 이미지가 없습니다 (마지막 회차 이후이거나 로그인이 필요한 페이지일 수 있음)' });
      set(r, { step: 'pdf' });
      const build = () =>
        createPdf(a.items.map((it, i) => ({ url: it.originalUrl, label: `${i + 1}번째` })), {
          title: a.title,
          layout: $('#bLayout').value,
          readViaPage: async (url) => (await chrome.scripting.executeScript({ target: { tabId }, func: readImageInPage, args: [url] }))[0]?.result,
        });
      let pdf = await build();
      const blocked = pdf.skipped.filter((s) => s.needsPermission);
      if (blocked.length) {
        set(r, { step: 'permission' });
        const origins = [...new Set(blocked.map((s) => new URL(s.url).origin))];
        if (await askForImageHosts(origins)) {
          // Fresh prober and cookie policy now that the servers are reachable.
          setCredentialPolicy(hostAccessPolicy());
          ctx.probe = createProber({ decode: decodeWithImage, concurrency: 8 });
          set(r, { step: 'pdf' });
          pdf = await build();
        }
      }
      if (!pdf.blob) return set(r, { step: 'failed', error: pdf.skipped[0]?.reason || 'PDF에 넣을 수 있는 이미지가 없습니다' });
      const name = sanitizeFilename(a.title) || `page_${r.n}`;
      const file = `${buildFolder({ ...settings, folderMode: 'none', subFolder: $('#bFolder').value.trim() })}/${name}.pdf`;
      await savePdf(pdf.blob, file);
      const missing = pdf.skipped.length;
      set(r, { step: 'done', file, images: pdf.included, error: missing ? `${missing}장 제외: ${pdf.skipped[0].reason}` : '' });
    } catch (e) {
      set(r, { step: 'failed', error: String(e?.message || e) });
    } finally {
      if (tabId != null) chrome.tabs.remove(tabId).catch(() => {});
    }
  }

  async function run(list) {
    running = true;
    stop = false;
    $('#bStart').disabled = $('#bRun').disabled = true;
    $('#bStop').disabled = false;
    const ctx = { probe: createProber({ decode: decodeWithImage, concurrency: 8 }), filters: currentFilters() };
    setCredentialPolicy(hostAccessPolicy());
    try {
      for (const r of list) {
        if (stop) {
          set(r, { step: 'stopped' });
          continue;
        }
        await processRow(r, ctx);
        if (r !== list.at(-1) && !stop) await wait(Math.max(0, Number($('#bDelay').value) || 0) * 1000); // be gentle with the site
      }
    } finally {
      running = false;
      $('#bStart').disabled = $('#bRun').disabled = false;
      $('#bStop').disabled = true;
      const done = rows.filter((r) => r.step === 'done').length;
      toast(`연속 PDF: ${done}개 저장${stop ? ' (중지됨)' : ''}`, 4000);
    }
  }

  $('#bRun').addEventListener('click', async () => {
    if (running) return;
    let list;
    try {
      list = series();
    } catch (e) {
      return toast(e.message);
    }
    // Opening tabs by itself needs access to that site (activeTab covers only a tab the user opened the menu on).
    const origin = new URL(list[0].url).origin;
    const granted = await chrome.permissions.request({ origins: [`${origin}/*`] }).catch(() => false);
    if (!granted) return toast(`${new URL(origin).host} 접근을 허용해야 페이지를 자동으로 열 수 있습니다.`, 4000);
    rows = list.map((x) => ({ ...x, step: 'waiting', tr: h('tr') }));
    rows.forEach(renderRow);
    tbody.replaceChildren(...rows.map((r) => r.tr));
    $('#bTable').hidden = false;
    summary();
    run(rows);
  });
  $('#bStop').addEventListener('click', () => {
    stop = true;
    toast('지금 처리 중인 페이지까지만 하고 멈춥니다.');
  });
  $('#bRetry').addEventListener('click', () => {
    if (running) return;
    const again = rows.filter((r) => ['failed', 'stopped', 'skipped'].includes(r.step));
    if (!again.length) return toast('다시 할 항목이 없습니다.');
    again.forEach((r) => set(r, { step: 'waiting', error: '' }));
    run(again);
  });
}
