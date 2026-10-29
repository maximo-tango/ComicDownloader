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
import { findNumericParams, makeSeries, notFoundReason } from '../lib/batch.js';

const STEP = {
  waiting: '대기', opening: '페이지 여는 중', scrolling: '스크롤하며 이미지 불러오는 중', analyzing: '원본 확인 중',
  pdf: 'PDF 만드는 중', done: '완료', skipped: '건너뜀', failed: '실패', stopped: '중지됨', permission: '권한 필요',
  checking: '있는 페이지인지 확인 중', notfound: '없음',
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
    return makeSeries($('#bUrl').value.trim(), p, $('#bStart').value, $('#bEnd').value.trim(), $('#bStep').value || 1);
  }
  function preview() {
    try {
      const sr = series();
      const first = sr.at(0).url;
      $('#bPreview').textContent =
        sr.count == null
          ? `끝 번호 없음: ${first}부터 시작해, 없는 주소가 ${$('#bStopAfter').value || 10}번 연달아 나오면 멈춥니다.`
          : `${sr.count.toLocaleString()}개 주소: ${first}${sr.count > 1 ? ` … ${sr.at(sr.count - 1).url}` : ''} (없는 주소는 확인 후 건너뜀)`;
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
  for (const id of ['bStart', 'bEnd', 'bStep', 'bStopAfter']) $('#' + id).addEventListener('input', preview);
  $('#bShowMissing').addEventListener('change', () => rows.forEach(renderRow));

  // ---- table --------------------------------------------------------------
  function renderRow(r) {
    // Missing addresses can be the majority of a sparse range: hidden unless asked for.
    r.tr.hidden = r.step === 'notfound' && !$('#bShowMissing').checked;
    r.tr.replaceChildren(
      h('td', {}, String(r.n)),
      h('td', { class: 'url', title: r.url }, r.title || r.url),
      h('td', {}, h('span', { class: `st ${r.step === 'done' ? 'success' : r.step === 'failed' ? 'failed' : ['skipped', 'stopped', 'notfound'].includes(r.step) ? 'cancelled' : r.step === 'waiting' ? 'pending' : 'downloading'}` }, STEP[r.step])),
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
  let total = null; // series length (null = open-ended)
  function summary() {
    const c = (st) => rows.filter((r) => r.step === st).length;
    const left = total == null ? '' : ` · 남음 ${Math.max(0, total - rows.length) + c('waiting')}`;
    $('#bSummary').textContent = rows.length
      ? `확인 ${rows.length}${total == null ? '' : ` / ${total}`} · 완료 ${c('done')} · 없음 ${c('notfound')} · 건너뜀 ${c('skipped')} · 실패 ${c('failed')}${left}`
      : '';
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

  /**
   * Cheap check before opening a tab: one request for the page itself.
   * @returns reason when the address doesn't exist, '' when it does or we can't tell
   */
  async function precheck(url, param) {
    try {
      const resp = await fetch(url, { credentials: 'include', redirect: 'follow' });
      let title = '';
      let bodyText = null;
      if (/html/i.test(resp.headers.get('content-type') || '')) {
        const doc = new DOMParser().parseFromString((await resp.text()).slice(0, 500000), 'text/html');
        doc.querySelectorAll('script, style, noscript, template').forEach((e) => e.remove());
        title = doc.title || '';
        bodyText = doc.body?.textContent ?? '';
      }
      return notFoundReason({ status: resp.status, requestedUrl: url, finalUrl: resp.url, param, title, bodyText });
    } catch {
      return ''; // network/CORS trouble: open the page and look
    }
  }

  async function processRow(r, ctx) {
    const settings = getSettings();
    let tabId = null;
    try {
      set(r, { step: 'checking', error: '' });
      const absent = await precheck(r.url, ctx.param);
      if (absent) return set(r, { step: 'notfound', error: absent });
      set(r, { step: 'opening' });
      tabId = await openTab(r.url);
      await wait(800);
      // Pages that say "not found" only after scripts run, or redirect by script.
      const [{ result: here }] = await chrome.scripting.executeScript({ target: { tabId }, func: () => ({ url: location.href, title: document.title, text: (document.body?.innerText || '').slice(0, 2000) }) });
      const late = notFoundReason({ requestedUrl: r.url, finalUrl: here.url, param: ctx.param, title: here.title, bodyText: here.text });
      if (late) return set(r, { step: 'notfound', title: here.title, error: late });
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

  /**
   * Processes the series one address at a time. `source` is either a lazy
   * series (rows created as we go) or an array of existing rows (retry).
   */
  async function run(source) {
    running = true;
    stop = false;
    $('#bRun').disabled = $('#bRetry').disabled = true;
    $('#bStop').disabled = false;
    const ctx = { probe: createProber({ decode: decodeWithImage, concurrency: 8 }), filters: currentFilters(), param: currentParam() };
    setCredentialPolicy(hostAccessPolicy());
    const stopAfter = Math.max(1, Number($('#bStopAfter').value) || 10);
    let misses = 0;
    let endedBy = '';
    try {
      for (let i = 0; ; i++) {
        let r;
        if (Array.isArray(source)) {
          r = source[i];
          if (!r) break;
        } else {
          const next = source.at(i);
          if (!next) break;
          r = { ...next, step: 'waiting', tr: h('tr') };
          rows.push(r);
          tbody.append(r.tr);
          renderRow(r);
        }
        if (stop) {
          set(r, { step: 'stopped' });
          endedBy = '중지됨';
          break;
        }
        await processRow(r, ctx);
        const miss = r.step === 'notfound' || (r.step === 'skipped' && !r.images);
        misses = miss ? misses + 1 : 0;
        // Open-ended series end after a run of missing addresses.
        if (!Array.isArray(source) && source.count == null && misses >= stopAfter) {
          endedBy = `없는 주소 ${misses}번 연속 — 끝으로 판단`;
          break;
        }
        if (stop) continue;
        const last = Array.isArray(source) ? i === source.length - 1 : source.count != null && i === source.count - 1;
        if (last) break;
        // Gentle on the site: a short pause after a missing address, the configured one after a real page.
        await wait(r.step === 'notfound' ? 300 : Math.max(0, Number($('#bDelay').value) || 0) * 1000);
      }
    } finally {
      running = false;
      $('#bRun').disabled = $('#bRetry').disabled = false;
      $('#bStop').disabled = true;
      summary();
      const done = rows.filter((r) => r.step === 'done').length;
      toast(`연속 PDF: ${done}개 저장${endedBy ? ` (${endedBy})` : ''}`, 5000);
    }
  }

  $('#bRun').addEventListener('click', async () => {
    if (running) return toast('이미 진행 중입니다. 끝나거나 중지한 뒤 다시 시작하세요.');
    let sr;
    try {
      sr = series();
    } catch (e) {
      return toast(e.message);
    }
    // Opening tabs by itself needs access to that site (activeTab covers only a tab the user opened the menu on).
    const origin = new URL(sr.at(0).url).origin;
    const granted = await chrome.permissions.request({ origins: [`${origin}/*`] }).catch(() => false);
    if (!granted) return toast(`${new URL(origin).host} 접근을 허용해야 페이지를 자동으로 열 수 있습니다.`, 4000);
    rows = [];
    total = sr.count;
    tbody.replaceChildren();
    $('#bTable').hidden = false;
    summary();
    run(sr);
  });
  $('#bStop').addEventListener('click', () => {
    stop = true;
    toast('지금 처리 중인 페이지까지만 하고 멈춥니다.');
  });
  $('#bRetry').addEventListener('click', () => {
    if (running) return;
    const again = rows.filter((r) => ['failed', 'stopped', 'skipped'].includes(r.step));
    if (!again.length) return toast('다시 할 항목이 없습니다. (없는 주소는 다시 하지 않습니다)');
    again.forEach((r) => set(r, { step: 'waiting', error: '' }));
    run(again);
  });
}
