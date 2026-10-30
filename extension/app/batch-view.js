// "연속 PDF" view: open a series of pages (one number in the URL changes, or
// links picked from a list page), scroll each to load its images, keep the ones
// matching the size filter and save one PDF per page. Pages are processed one at a time.

import { $, h, toast } from './common.js';
import { createPdf, savePdf } from './pdf-export.js';
import { collectImages, collectLinks, autoScroll, readImageInPage } from '../content/collector.js';
import { createProber, decodeWithImage, hostAccessPolicy, setCredentialPolicy } from '../lib/probe.js';
import { resolveEntry } from '../lib/resolver.js';
import { applyFilters, DEFAULT_FILTERS, relaxations } from '../lib/filters.js';
import { dedupeInOrder, screenOrder } from '../lib/ordering.js';
import { urlKey } from '../lib/url-utils.js';
import { buildFolder, sanitizeFilename } from '../lib/filename.js';
import { findNumericParams, makeSeries, notFoundReason, pickFromLists, similarHint } from '../lib/batch.js';

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
  $('#bOrder').value = s0.orderMode === 'dom' ? 'dom' : 'screen';

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

  // ---- list page mode -----------------------------------------------------
  const mode = () => document.querySelector('input[name="bMode"]:checked').value;
  function setMode(m) {
    document.querySelector(`input[name="bMode"][value="${m}"]`).checked = true;
    $('#bListPanel').hidden = m !== 'list';
    $('#bSeriesPanel').hidden = m === 'list';
  }
  for (const r of document.querySelectorAll('input[name="bMode"]')) r.addEventListener('change', () => setMode(mode()));

  // List pages read so far ({ url, links }); "링크 찾기" on another page appends to them,
  // so a list split over several pages (navigation) becomes one list.
  let listSources = [];
  let picked = [];
  const unchecked = new Set();
  let reversed = false;
  let fetching = false;

  function renderLinks() {
    const tb = $('#lTable tbody');
    if (!listSources.length) {
      picked = [];
      tb.replaceChildren();
      $('#lTable').hidden = true;
      return;
    }
    const opts = { contains: $('#lContains').value };
    const counts = { similar: pickFromLists(listSources, { ...opts, rule: 'similar' }).length, site: pickFromLists(listSources, { ...opts, rule: 'site' }).length };
    const [o1, o2] = $('#lRule').options;
    const first = listSources[0].url;
    o1.textContent = `목록 주소와 비슷한 링크 (${similarHint(first)}${listSources.length > 1 ? ' 등' : ''}) — ${counts.similar}개`;
    o2.textContent = `같은 사이트 전체 (${new URL(first).origin}/) — ${counts.site}개`;
    picked = pickFromLists(listSources, { ...opts, rule: $('#lRule').value });
    if (reversed) picked.reverse();
    tb.replaceChildren(
      ...picked.map((l, i) => {
        const box = h('input', { type: 'checkbox', 'aria-label': `${i + 1}번 선택` });
        box.checked = !unchecked.has(l.url);
        box.addEventListener('change', () => {
          box.checked ? unchecked.delete(l.url) : unchecked.add(l.url);
          linkSummary();
        });
        return h('tr', {}, h('td', { class: 'c-check' }, box), h('td', {}, String(i + 1)), h('td', {}, l.text), h('td', { class: 'url', title: l.url }, l.url));
      }),
    );
    $('#lTable').hidden = !picked.length;
    linkSummary();
  }
  const chosenLinks = () => picked.filter((l) => !unchecked.has(l.url));
  function linkSummary() {
    $('#lPreview').classList.toggle('error', !picked.length);
    const pages = listSources.length > 1 ? `목록 페이지 ${listSources.length}개 · ` : '';
    $('#lPreview').textContent = picked.length
      ? `${pages}링크 ${picked.length}개 중 ${chosenLinks().length}개 선택 · 위에서부터 차례로 처리합니다${reversed ? ' (뒤집은 순서)' : ''}`
      : `${pages}조건에 맞는 링크가 없습니다 (페이지의 링크 ${listSources.reduce((n, s) => n + s.links.length, 0)}개). 추출 범위를 "같은 사이트 전체"로 바꿔 보세요.`;
  }
  $('#lRule').addEventListener('change', renderLinks);
  $('#lContains').addEventListener('input', renderLinks);
  $('#lAll').addEventListener('click', () => {
    picked.forEach((l) => unchecked.delete(l.url));
    renderLinks();
  });
  $('#lNone').addEventListener('click', () => {
    picked.forEach((l) => unchecked.add(l.url));
    renderLinks();
  });
  $('#lClear').addEventListener('click', () => {
    listSources = [];
    unchecked.clear();
    reversed = false;
    renderLinks();
    $('#lPreview').classList.remove('error');
    $('#lPreview').textContent = '';
  });
  $('#lReverse').addEventListener('click', () => {
    reversed = !reversed;
    renderLinks();
  });

  $('#lFetch').addEventListener('click', async () => {
    if (fetching || running) return toast(running ? '연속 PDF가 진행 중입니다.' : '링크를 찾는 중입니다.');
    let u;
    try {
      u = new URL($('#lUrl').value.trim());
      if (!/^https?:$/.test(u.protocol)) throw new Error();
    } catch {
      return toast('목록 주소(http:// 또는 https://)를 입력하세요.');
    }
    // Reading the list in a tab of its own needs access to that site.
    const granted = await chrome.permissions.request({ origins: [`${u.origin}/*`] }).catch(() => false);
    if (!granted) return toast(`${u.host} 접근을 허용해야 목록 페이지를 열 수 있습니다.`, 4000);
    fetching = true;
    $('#lFetch').disabled = true;
    $('#lPreview').classList.remove('error');
    $('#lPreview').textContent = '목록 페이지 여는 중…';
    let tabId = null;
    try {
      tabId = await openTab(u.href);
      await wait(800);
      if ($('#lScroll').checked) {
        $('#lPreview').textContent = '목록을 스크롤하며 링크 불러오는 중…';
        await scrollInTab(tabId, getSettings().scrollMaxScreens);
      }
      const [{ result }] = await chrome.scripting.executeScript({ target: { tabId }, func: collectLinks });
      const src = { url: result.pageUrl, links: result.links };
      const known = listSources.findIndex((s) => s.url === src.url);
      const before = picked.length;
      if (known >= 0) listSources[known] = src; // the same list page again: refresh it
      else listSources.push(src);
      if (listSources.length === 1) $('#lRule').value = pickFromLists(listSources, { rule: 'similar' }).length ? 'similar' : 'site';
      renderLinks();
      if (listSources.length > 1 || known >= 0) toast(`링크 ${Math.max(0, picked.length - before)}개를 목록에 더했습니다 (목록 페이지 ${listSources.length}개).`);
    } catch (e) {
      $('#lPreview').classList.add('error');
      $('#lPreview').textContent = `목록을 읽지 못했습니다: ${e?.message || e}`;
    } finally {
      fetching = false;
      $('#lFetch').disabled = false;
      if (tabId != null) chrome.tabs.remove(tabId).catch(() => {});
    }
  });

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
    let resolved = await Promise.all(entries.map((e) => resolveEntry(e, probe, opts)));
    if ($('#bOrder').value !== 'dom') resolved = screenOrder(resolved);
    const { unique } = dedupeInOrder(resolved, (it) => urlKey(it.originalUrl));
    let items = applyFilters(unique, filters).items;
    let relaxed = '';
    // Images on the page but none match: loosen the format/thumbnail conditions step by step.
    if (!items.length && unique.length && $('#bRelax').checked) {
      for (const step of relaxations(filters)) {
        items = applyFilters(unique, step.filters).items;
        if (items.length) {
          relaxed = step.note;
          break;
        }
      }
    }
    return { title: result.title, pageUrl: result.pageUrl, found: unique.length, items, relaxed };
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
      if (!a.items.length) {
        const why = a.found
          ? `찾은 ${a.found}장 중 조건에 맞는 이미지가 없습니다${$('#bRelax').checked ? ' (썸네일·WEBP 조건을 풀어도 없음 — 최소 너비·높이를 확인하세요)' : ''}`
          : '조건에 맞는 이미지가 없습니다 (마지막 회차 이후이거나 로그인이 필요한 페이지일 수 있음)';
        return set(r, { step: 'skipped', error: why });
      }
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
      const saved = await savePdf(pdf.blob, file);
      const missing = pdf.skipped.length;
      const notes = [a.relaxed && `조건 완화: ${a.relaxed}`, missing && `${missing}장 제외: ${pdf.skipped[0].reason}`].filter(Boolean);
      set(r, { step: 'done', file: saved, images: pdf.included, error: notes.join(' · ') });
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
    const ctx = { probe: createProber({ decode: decodeWithImage, concurrency: 8 }), filters: currentFilters(), param: mode() === 'list' ? null : currentParam() };
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
    if (fetching) return toast('목록에서 링크를 찾는 중입니다.');
    let sr;
    try {
      if (mode() === 'list') {
        const chosen = chosenLinks();
        if (!listSources.length) throw new Error('목록 주소를 넣고 "링크 찾기"를 누르세요.');
        if (!chosen.length) throw new Error('처리할 링크를 하나 이상 선택하세요.');
        sr = { count: chosen.length, at: (i) => (i < chosen.length ? { n: i + 1, url: chosen[i].url, title: chosen[i].text } : null) };
      } else sr = series();
    } catch (e) {
      return toast(e.message);
    }
    // Opening tabs by itself needs access to that site (activeTab covers only a tab the user opened the menu on).
    // Links gathered from several list pages may span more than one site.
    const origins = [...new Set((mode() === 'list' ? chosenLinks().map((l) => l.url) : [sr.at(0).url]).map((u) => new URL(u).origin))];
    const granted = await chrome.permissions.request({ origins: origins.map((o) => `${o}/*`) }).catch(() => false);
    if (!granted) return toast(`${origins.map((o) => new URL(o).host).join(', ')} 접근을 허용해야 페이지를 자동으로 열 수 있습니다.`, 4000);
    rows = [];
    total = sr.count;
    tbody.replaceChildren();
    $('#bTable').hidden = false;
    summary();
    run(sr);
  });

  return {
    /** Prefill from the menu: a list page address. */
    openList(url) {
      setMode('list');
      $('#lUrl').value = url;
    },
  };
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
