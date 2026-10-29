import { $, command, h, rafThrottle, toast } from './common.js';
import { badges, dimsText, displayName, extText, sizeText } from './item-format.js';
import { initPasteView } from './paste-view.js';
import { initDownloadsView } from './downloads-view.js';
import { createPdf, savePdf } from './pdf-export.js';
import { collectImages, autoScroll, readImageInPage } from '../content/collector.js';
import { createProber, decodeWithImage, hostAccessPolicy, measureFullSize, setCredentialPolicy } from '../lib/probe.js';
import { resolveEntry, selectCandidate, ORIGINAL_STATE, SOURCE_LABEL } from '../lib/resolver.js';
import { ALL_FORMATS, ALL_STATES, LIMITS, applyFilters, parseLimit } from '../lib/filters.js';
import { buildFolder, fallbackBaseName, sanitizeFilename } from '../lib/filename.js';
import { urlBasename, urlKey } from '../lib/url-utils.js';
import { dedupeInOrder, mergeOrder } from '../lib/ordering.js';
import { loadSettings, saveSettings } from '../lib/settings.js';

let settings = await loadSettings();
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.settings) settings = { ...settings, ...changes.settings.newValue };
});
setCredentialPolicy(hostAccessPolicy());
const probe = createProber({ decode: decodeWithImage, concurrency: 8 });
const params = new URLSearchParams(location.search);

// ---------------------------------------------------------------- state
// Items are keyed by a stable per-element id from the page, so URL changes,
// rescans and filters never move or reset them. `order` is the page order.
const state = {
  tabId: Number(params.get('tabId')) || null,
  docId: null,
  page: null, // { url, title }
  items: new Map(),
  order: [],
  selected: new Set(),
  scanning: false,
  scanGen: 0,
  scrolledOnce: false,
  jobsByItem: new Map(),
  focusId: null,
};
const cards = new Map();

// ---------------------------------------------------------------- views
for (const tab of document.querySelectorAll('.tab')) {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === tab));
    document.querySelectorAll('.view').forEach((v) => (v.hidden = v.id !== `view-${tab.dataset.view}`));
  });
}
const showView = (name) => document.querySelector(`.tab[data-view="${name}"]`)?.click();
$('#openOptions').addEventListener('click', () => chrome.runtime.openOptionsPage());

// ---------------------------------------------------------------- filters UI
const chipSet = (container, values, label, initial = values) => {
  const on = new Set(values.filter((v) => initial.includes(v)));
  container.append(
    ...values.map((v) =>
      h('button', {
        class: on.has(v) ? 'chip on' : 'chip',
        type: 'button',
        'aria-pressed': String(on.has(v)),
        onclick: (e) => {
          on.has(v) ? on.delete(v) : on.add(v);
          e.currentTarget.classList.toggle('on', on.has(v));
          e.currentTarget.setAttribute('aria-pressed', String(on.has(v)));
          render();
        },
      }, label(v)),
    ),
  );
  return on;
};
// Starting filters come from the settings (default: JPG only, thumbnails hidden).
const startFormats = Array.isArray(settings.filterFormats) && settings.filterFormats.length ? settings.filterFormats : ALL_FORMATS;
const formatOn = chipSet($('#fFormats'), ALL_FORMATS, (f) => (f === 'OTHER' ? '기타' : f === 'JPEG' ? 'JPG' : f), startFormats);
$('#fNoThumb').checked = !!settings.filterNoThumb;
const stateOn = chipSet($('#fStates'), ALL_STATES, (s) => ORIGINAL_STATE[s]);
for (const id of ['fMinW', 'fMinH', 'fMinSize', 'fSizeUnit', 'fUnknownSize', 'fNoThumb']) $('#' + id).addEventListener('input', () => render());

function currentFilters() {
  const errors = [];
  const read = (id, max, label) => {
    const r = parseLimit($('#' + id).value, max);
    $('#' + id).classList.toggle('invalid', !!r.error);
    if (r.error) errors.push(`${label}: ${r.error}`);
    return r.value;
  };
  const unit = Number($('#fSizeUnit').value);
  const f = {
    minWidth: read('fMinW', LIMITS.px, '최소 너비'),
    minHeight: read('fMinH', LIMITS.px, '최소 높이'),
    minBytes: read('fMinSize', Math.floor(LIMITS.bytes / unit), '최소 파일 크기') * unit,
    unknownSize: $('#fUnknownSize').value,
    formats: formatOn.size === ALL_FORMATS.length ? null : [...formatOn],
    states: stateOn.size === ALL_STATES.length ? null : [...stateOn],
    excludeThumbnails: $('#fNoThumb').checked,
  };
  $('#filterError').textContent = errors.join(' · ');
  return f;
}

// ---------------------------------------------------------------- preview size
function setPreviewSize(size, save = true) {
  const grid = $('#grid');
  grid.classList.remove('size-small', 'size-medium', 'size-large');
  grid.classList.add(`size-${size}`);
  for (const b of document.querySelectorAll('.segmented button')) b.setAttribute('aria-checked', String(b.dataset.size === size));
  if (save) saveSettings({ previewSize: size });
  // Keep the item the user was on in view; nothing else changes.
  if (state.focusId) cards.get(state.focusId)?.el.scrollIntoView({ block: 'nearest' });
}
for (const b of document.querySelectorAll('.segmented button')) b.addEventListener('click', () => setPreviewSize(b.dataset.size));
setPreviewSize(settings.previewSize || 'medium', false);

// ---------------------------------------------------------------- view model
/**
 * Page order → URL de-duplication (first occurrence wins) → display filter.
 * Filtering keeps relative order and never touches the data or selection.
 */
function computeView() {
  const ordered = state.order.map((id) => state.items.get(id)).filter(Boolean);
  const { unique, duplicates } = dedupeInOrder(ordered, (it) => (it.urlError ? null : urlKey(it.originalUrl || it.displayUrl)));
  unique.forEach((it, i) => (it.seq = i + 1));
  const { items: visible, hiddenUnknownSize } = applyFilters(unique, currentFilters());
  return { unique, visible, duplicates, hiddenUnknownSize };
}

// ---------------------------------------------------------------- cards
function candidateLabel(c) {
  const size = c.ok ? (c.width ? `${c.width}×${c.height}` : '해상도 확인 불가') : `실패: ${c.error || '접근 불가'}`;
  return `${size} · ${SOURCE_LABEL[c.kind] || c.kind} · ${c.url.startsWith('data:') ? 'data URL' : urlBasename(c.url) || c.url}`;
}

function cardFor(item) {
  let c = cards.get(item.id);
  if (!c) {
    const pick = h('input', { type: 'checkbox', class: 'pick', 'aria-label': '선택' });
    const seq = h('span', { class: 'seq' });
    const img = h('img', { loading: 'lazy', alt: '', decoding: 'async' });
    const noprev = h('span', { class: 'noprev', hidden: true }, '미리보기 없음');
    const thumb = h('div', { class: 'thumb', title: '클릭하여 선택 / 해제' }, img, noprev);
    const dims = h('div', { class: 'dims' });
    const sub = h('div', { class: 'sub' });
    const badgeBox = h('div', { class: 'badges' });
    const cand = h('select', { class: 'cand', hidden: true, title: '다운로드할 원본 후보 선택' });
    const name = h('div', { class: 'name' });
    const el = h('div', { class: 'card', tabindex: '-1', role: 'option', dataset: { id: item.id } }, pick, seq, thumb, h('div', { class: 'meta' }, dims, sub, badgeBox, cand, name));
    pick.addEventListener('click', (e) => onPick(item.id, e.target.checked, e.shiftKey));
    thumb.addEventListener('click', (e) => {
      if (item.urlError) return;
      onPick(item.id, !state.selected.has(item.id), e.shiftKey);
    });
    el.addEventListener('focus', () => (state.focusId = item.id));
    img.addEventListener('error', () => {
      // A broken preview never blocks the rest of the card.
      img.hidden = true;
      noprev.hidden = false;
    });
    cand.addEventListener('change', () => {
      const it = state.items.get(item.id);
      const upd = selectCandidate(it, cand.value);
      if (upd) Object.assign(it, upd);
      render();
    });
    c = { el, pick, seq, img, noprev, dims, sub, badgeBox, cand, name, sig: '' };
    cards.set(item.id, c);
  }
  const job = state.jobsByItem.get(item.id);
  const sig = [item.seq, item.pending, item.width, item.height, item.format, item.formatVerified, item.bytes, item.originalState, item.isThumbnail, item.sourceType, item.originalUrl, item.userChosen, item.inPage, job?.status, job?.error].join('|');
  if (sig !== c.sig) {
    c.sig = sig;
    c.seq.textContent = `#${item.seq}`;
    c.el.classList.toggle('broken', !!item.urlError);
    c.el.classList.toggle('pending', !!item.pending);
    c.pick.disabled = !!item.urlError;
    if (item.urlError) {
      c.img.hidden = true;
      c.noprev.hidden = false;
      c.noprev.textContent = item.urlError;
    } else {
      const preview = item.displayUrl && !item.displayUrl.startsWith('data:') ? item.displayUrl : item.originalUrl;
      if (c.img.getAttribute('src') !== preview) {
        c.img.hidden = false;
        c.noprev.hidden = true;
        c.img.src = preview;
      }
    }
    c.dims.textContent = dimsText(item);
    c.sub.textContent = item.urlError ? `발견 위치: ${item.elementType}` : `${extText(item)} · ${sizeText(item)}`;
    c.badgeBox.replaceChildren(...badges(item, job));
    const verified = (item.candidates || []).filter((x) => x.ok);
    c.cand.hidden = item.pending || verified.length < 2;
    if (!c.cand.hidden) {
      c.cand.replaceChildren(...item.candidates.map((x) => h('option', { value: x.url, selected: x.url === item.originalUrl, disabled: !x.ok }, candidateLabel(x))));
    }
    const link = item.urlError || item.originalUrl.startsWith('data:') ? h('span', {}, displayName(item)) : h('a', { href: item.originalUrl, target: '_blank', rel: 'noreferrer', title: item.originalUrl }, displayName(item) + ' ↗');
    c.name.replaceChildren(link);
  }
  const sel = state.selected.has(item.id);
  c.pick.checked = sel;
  c.el.classList.toggle('selected', sel);
  c.el.setAttribute('aria-selected', String(sel));
  return c.el;
}

let lastVisible = [];
let lastIds = '';
let anchorId = null;
function onPick(id, on, shift) {
  if (shift && anchorId) {
    // Shift selects/deselects the whole range in the current list order.
    const a = lastVisible.findIndex((x) => x.id === anchorId);
    const b = lastVisible.findIndex((x) => x.id === id);
    if (a >= 0 && b >= 0) {
      for (const it of lastVisible.slice(Math.min(a, b), Math.max(a, b) + 1)) {
        if (!it.urlError) on ? state.selected.add(it.id) : state.selected.delete(it.id);
      }
    }
  } else {
    on ? state.selected.add(id) : state.selected.delete(id);
  }
  anchorId = id;
  render();
}

const render = rafThrottle(() => {
  const { unique, visible, duplicates, hiddenUnknownSize } = computeView();
  lastVisible = visible;
  for (const it of visible) cardFor(it);
  const ids = visible.map((x) => x.id).join('\n');
  if (ids !== lastIds) {
    $('#grid').replaceChildren(...visible.map((it) => cards.get(it.id).el));
    lastIds = ids;
  }
  const uniqueIds = new Set(unique.map((x) => x.id));
  for (const id of [...state.selected]) {
    if (uniqueIds.has(id)) continue;
    // The item turned out to be a duplicate: keep the selection on the first occurrence.
    state.selected.delete(id);
    if (duplicates.has(id)) state.selected.add(duplicates.get(id));
  }
  const visibleIds = new Set(visible.map((x) => x.id));
  const selected = state.selected.size;
  const hiddenSelected = [...state.selected].filter((id) => !visibleIds.has(id)).length;
  // Download and PDF act on what is selected *and shown*; hidden selections are kept for later.
  const actionable = selected - hiddenSelected;
  $('#countLine').replaceChildren(
    `추출 ${unique.length}개 · 표시 ${visible.length}개 · 선택 ${actionable}개`,
    h('small', {}, [
      hiddenSelected ? ` (필터로 숨겨진 선택 ${hiddenSelected}개는 보관만 하고 다운로드·PDF에서 제외)` : '',
      duplicates.size ? ` · 같은 URL ${duplicates.size}개는 첫 항목으로 합침` : '',
      hiddenUnknownSize ? ` · 크기 확인 불가 ${hiddenUnknownSize}개 숨김` : '',
    ].join('')),
  );
  $('#btnDownload').textContent = `선택 다운로드 (${actionable})`;
  $('#btnDownload').disabled = !actionable;
  $('#btnPdf').textContent = `PDF로 저장 (${actionable})`;
  $('#btnPdf').disabled = !actionable || pdfRunning;
  const empty = $('#emptyMsg');
  empty.hidden = visible.length > 0 || state.scanning;
  empty.textContent = unique.length ? '현재 필터에 맞는 이미지가 없습니다.' : state.tabId ? '찾은 이미지가 없습니다.' : '';
});

// ---------------------------------------------------------------- keyboard navigation in the list
$('#grid').addEventListener('keydown', (e) => {
  const cardsEls = [...$('#grid').children];
  if (!cardsEls.length) return;
  let i = cardsEls.indexOf(document.activeElement.closest?.('.card'));
  const cols = Math.max(1, cardsEls.filter((el) => el.offsetTop === cardsEls[0].offsetTop).length);
  const moves = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: cols, ArrowUp: -cols, Home: -Infinity, End: Infinity };
  if (e.key in moves) {
    e.preventDefault();
    i = i < 0 ? 0 : Math.min(cardsEls.length - 1, Math.max(0, i + moves[e.key]));
    cardsEls[i].focus();
    cardsEls[i].scrollIntoView({ block: 'nearest' });
  } else if ((e.key === ' ' || e.key === 'Spacebar') && i >= 0 && e.target === cardsEls[i]) {
    e.preventDefault();
    const id = cardsEls[i].dataset.id;
    if (!state.items.get(id)?.urlError) onPick(id, !state.selected.has(id), e.shiftKey);
  } else if (e.key === 'Enter' && i >= 0 && e.target === cardsEls[i]) {
    const it = state.items.get(cardsEls[i].dataset.id);
    if (it && !it.urlError && /^https?:/.test(it.originalUrl)) window.open(it.originalUrl, '_blank', 'noreferrer');
  }
});

// ---------------------------------------------------------------- selection buttons
$('#btnSelectAll').addEventListener('click', () => {
  for (const it of computeView().unique) if (!it.urlError) state.selected.add(it.id);
  render();
});
$('#btnSelectNone').addEventListener('click', () => {
  state.selected.clear();
  render();
});
$('#btnSelectVisible').addEventListener('click', () => {
  state.selected = new Set(computeView().visible.filter((x) => !x.urlError).map((x) => x.id));
  render();
});

// ---------------------------------------------------------------- scanning
function setStatus(text) {
  $('#scanStatus').textContent = text;
}

function showPage() {
  $('#pageTitle').textContent = state.page?.title || state.page?.url || '분석할 페이지가 없습니다';
  $('#pageUrl').textContent = state.page?.url || (state.tabId ? '' : '웹페이지에서 Image Hunter 메뉴를 열고 "이 페이지의 이미지 찾기"를 누르세요.');
  if (state.page) document.title = `Image Hunter — ${state.page.title || state.page.url}`;
}

function resetResults() {
  state.scanGen++;
  state.items.clear();
  state.order = [];
  state.selected.clear();
  state.scrolledOnce = false;
  cards.clear();
  lastIds = '';
}

const candSig = (e) => e.candidates.map((c) => c.url).join('|') + '|' + (e.urlError || '');

function fromEntry(e) {
  return {
    entry: e,
    candSig: candSig(e),
    displayUrl: e.displayUrl,
    elementType: e.elementType,
    urlKind: e.urlKind,
    urlError: e.urlError || null,
    originalUrl: e.displayUrl,
    sourcePageUrl: e.pageUrl,
    pending: !e.urlError,
  };
}

function accessError(e) {
  const m = String(e?.message || e);
  if (/Cannot access|cannot be scripted|permission|No tab with id|Frame with ID 0/i.test(m)) {
    return '이 탭에 접근할 수 없습니다. 페이지가 이동·종료되었거나 Chrome이 접근을 허용하지 않는 페이지입니다. 분석할 페이지에서 Image Hunter 메뉴를 다시 열어 주세요.';
  }
  return `이미지를 찾지 못했습니다: ${m}`;
}

async function runCollector() {
  try {
    return await chrome.scripting.executeScript({ target: { tabId: state.tabId, allFrames: true }, func: collectImages, args: [{}] });
  } catch {
    // Some frames may be off-limits (other sites without permission): fall back to the page itself.
    return chrome.scripting.executeScript({ target: { tabId: state.tabId }, func: collectImages, args: [{}] });
  }
}

async function scan({ scroll = false } = {}) {
  if (!state.tabId || state.scanning) return;
  state.scanning = true;
  let gen = state.scanGen;
  $('#btnScan').disabled = $('#btnScrollScan').disabled = true;
  let scrollNote = '';
  try {
    if (scroll) {
      setStatus('페이지를 스크롤하며 지연 로딩 이미지를 불러오는 중…');
      // Background tabs don't render, so lazy loaders (IntersectionObserver) never fire.
      // Show the page while scrolling, then come back here.
      const me = await chrome.tabs.getCurrent();
      const target = await chrome.tabs.get(state.tabId);
      await chrome.tabs.update(state.tabId, { active: true });
      await chrome.windows.update(target.windowId, { focused: true }).catch(() => {});
      try {
        const [{ result }] = await chrome.scripting.executeScript({
          target: { tabId: state.tabId },
          func: autoScroll,
          args: [{ maxScreens: settings.scrollMaxScreens, resume: state.scrolledOnce }],
        });
        state.scrolledOnce = true;
        scrollNote = result.reachedEnd ? ' · 페이지 끝까지 확인함' : ` · ${result.screens}화면까지 확인함 (더 있으면 다시 누르세요)`;
      } finally {
        await chrome.tabs.update(me.id, { active: true });
        await chrome.windows.update(me.windowId, { focused: true }).catch(() => {});
      }
    }
    setStatus('이미지를 찾는 중…');
    const results = await runCollector();
    if (gen !== state.scanGen) return;
    const main = results.find((r) => r.frameId === 0)?.result;
    if (!main) throw new Error('Cannot access the page');
    let notice = '';
    if (state.docId && main.docId !== state.docId) {
      // Another document is loaded in that tab now: never mix two pages' lists.
      resetResults();
      gen = state.scanGen; // this scan now belongs to the new page
      notice = '페이지가 바뀌어 목록을 새로 만들었습니다 (진행 중이거나 끝난 다운로드는 다운로드 탭에 그대로 있습니다). ';
    }
    state.docId = main.docId;
    state.page = { url: main.pageUrl, title: main.title };
    showPage();

    // Main frame first, then sub-frames in frame order.
    results.sort((a, b) => (a.frameId === 0 ? -1 : b.frameId === 0 ? 1 : a.frameId - b.frameId));
    const entries = [];
    for (const r of results) {
      if (!r.result) continue;
      for (const e of r.result.entries) entries.push({ ...e, key: `${r.frameId}:${e.key}`, pageUrl: main.pageUrl, frameUrl: r.result.pageUrl });
    }
    const keys = entries.map((e) => e.key);
    state.order = mergeOrder(state.order, keys);
    const inScan = new Set(keys);
    for (const it of state.items.values()) it.inPage = inScan.has(it.id);

    const toResolve = [];
    let added = 0;
    let updated = 0;
    for (const e of entries) {
      let it = state.items.get(e.key);
      if (!it) {
        it = { id: e.key, inPage: true, originalState: 'unknown', candidates: [], ...fromEntry(e) };
        state.items.set(e.key, it);
        added++;
        if (!it.urlError) toResolve.push(it);
      } else if (candSig(e) !== it.candSig && !it.userChosen) {
        // Same element, new URLs (e.g. a lazy image got its real source).
        Object.assign(it, fromEntry(e));
        updated++;
        if (!it.urlError) toResolve.push(it);
      }
    }
    render();
    await resolveItems(toResolve, gen);
    if (gen !== state.scanGen) return;
    const { unique } = computeView();
    const count = (s) => unique.filter((i) => i.originalState === s).length;
    setStatus(
      `${notice}이미지 ${unique.length}개 · 이번 검색에서 새로 발견 ${added}개, 갱신 ${updated}개 · ` +
        `원본 후보 확인 ${count('confirmed')} · 고해상도 후보 ${count('hires')} · 후보 비교 필요 ${count('compare')} · 확인 불가 ${count('unknown')}` +
        scrollNote,
    );
  } catch (e) {
    setStatus(accessError(e));
  } finally {
    state.scanning = false;
    $('#btnScan').disabled = $('#btnScrollScan').disabled = false;
    render();
  }
}

async function resolveItems(list, gen) {
  if (!list.length) return;
  let done = 0;
  const opts = { thumbMaxSide: settings.thumbMaxSide, maxVariants: 6, guessVariants: settings.guessVariants };
  const progress = () => setStatus(`원본 후보 확인 중… ${done} / ${list.length} (실제 해상도·형식 확인)`);
  progress();
  await Promise.all(
    list.map(async (it) => {
      const sig = it.candSig;
      const r = await resolveEntry(it.entry, probe, opts);
      if (gen !== state.scanGen || it.candSig !== sig || it.userChosen) return;
      const { order, ...fields } = r;
      Object.assign(it, fields, { pending: false });
      done++;
      progress();
      render();
    }),
  );
}

$('#btnScan').addEventListener('click', () => scan());
$('#btnScrollScan').addEventListener('click', () => scan({ scroll: true }));

// ---------------------------------------------------------------- file size check
$('#btnMeasure').addEventListener('click', async () => {
  const unknown = computeView().visible.filter((i) => i.bytes == null && !i.urlError && !i.pending && /^https?:/.test(i.originalUrl));
  if (!unknown.length) return toast('크기를 확인할 항목이 없습니다.');
  const btn = $('#btnMeasure');
  btn.disabled = true;
  let done = 0;
  let failed = 0;
  const queue = [...unknown];
  const worker = async () => {
    for (let it; (it = queue.shift()); ) {
      try {
        it.bytes = await measureFullSize(it.originalUrl);
      } catch {
        failed++;
      }
      btn.textContent = `확인 중 ${++done}/${unknown.length}`;
      render();
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  btn.textContent = '크기 확인';
  btn.disabled = false;
  toast(`크기 확인: ${unknown.length - failed}개 성공${failed ? `, ${failed}개는 사이트 권한이 없거나 응답이 없어 확인 불가` : ''}`, 4000);
});

// ---------------------------------------------------------------- downloading
async function enqueue(jobs) {
  return command('enqueue', { jobs, settings: { conflictAction: settings.conflictAction, concurrency: settings.concurrency } });
}

/** Selected items that are currently shown, in page order. Selections hidden by a
 *  filter are kept but never downloaded or put into a PDF behind the user's back. */
function selectedInOrder() {
  return computeView().visible.filter((it) => state.selected.has(it.id));
}

async function downloadItems(list) {
  const skipped = { pending: 0, done: 0 };
  const jobs = [];
  const retryIds = [];
  for (const it of list) {
    if (it.urlError) continue;
    if (it.pending) {
      skipped.pending++;
      continue;
    }
    const prev = state.jobsByItem.get(it.id);
    if (prev && prev.url === it.originalUrl) {
      if (['success', 'pending', 'downloading'].includes(prev.status)) {
        skipped.done++;
        continue;
      }
      // Failed/cancelled before: retry that job instead of adding a duplicate.
      retryIds.push(prev.id);
      continue;
    }
    jobs.push({
      url: it.originalUrl,
      sourceUrl: it.displayUrl,
      source: 'page',
      sourceTabId: state.tabId,
      itemKey: it.id,
      folder: buildFolder(settings, { pageTitle: state.page?.title, url: state.page?.url }),
      fallbackBase: fallbackBaseName(state.page?.title, it.seq),
      format: it.format,
      formatVerified: it.formatVerified,
      mime: it.mime,
      serverName: it.serverName,
      width: it.width,
      height: it.height,
      bytes: it.bytes,
    });
  }
  if (jobs.length) await enqueue(jobs);
  if (retryIds.length) await command('retry', { ids: retryIds });
  const notes = [];
  if (retryIds.length) notes.push(`실패·취소했던 ${retryIds.length}개 다시 시도`);
  if (skipped.done) notes.push(`이미 받았거나 진행 중인 ${skipped.done}개 제외`);
  if (skipped.pending) notes.push(`확인 중인 ${skipped.pending}개 제외`);
  const head = jobs.length ? `${jobs.length}개를 다운로드 대기열에 추가했습니다.` : '새로 추가한 다운로드가 없습니다.';
  toast(`${head}${notes.length ? ' (' + notes.join(', ') + ')' : ''}`, 3500);
}

$('#btnDownload').addEventListener('click', () => downloadItems(selectedInOrder()));

// ---------------------------------------------------------------- PDF
let pdfRunning = false;
let pdfAbort = null;
$('#btnPdf').addEventListener('click', async () => {
  const list = selectedInOrder().filter((it) => !it.urlError && !it.pending);
  if (!list.length) return toast('PDF에 넣을 이미지를 선택하세요.');
  pdfRunning = true;
  pdfAbort = new AbortController();
  render();
  const panel = $('#pdfPanel');
  panel.hidden = false;
  $('#pdfSkipped').replaceChildren();
  $('#pdfGrant').hidden = $('#pdfSavePartial').hidden = true;
  const title = state.page?.title || 'images';
  try {
    const result = await createPdf(
      list.map((it) => ({ url: it.originalUrl, label: `#${it.seq}` })),
      {
        title,
        layout: settings.pdfLayout,
        signal: pdfAbort.signal,
        // Same-origin images can be read through the page itself (its own cookies, no CORS bypass).
        readViaPage: state.tabId
          ? async (url) => (await chrome.scripting.executeScript({ target: { tabId: state.tabId }, func: readImageInPage, args: [url] }))[0]?.result
          : null,
        onProgress: (i, n) => {
          $('#pdfStatus').textContent = `PDF 만드는 중… ${i} / ${n}`;
          $('#pdfBar').style.width = `${Math.round((i / n) * 100)}%`;
        },
      },
    );
    $('#pdfSkipped').replaceChildren(...result.skipped.map((s) => h('li', {}, `${s.label} 제외: ${s.reason}`)));
    const filename = `${buildFolder(settings, { pageTitle: state.page?.title, url: state.page?.url })}/${sanitizeFilename(title) || 'images'}.pdf`;
    const save = async () => {
      $('#pdfSavePartial').hidden = true;
      await savePdf(result.blob, filename);
      $('#pdfStatus').textContent = `PDF 저장: ${result.included}장 포함${result.skipped.length ? `, ${result.skipped.length}장 제외` : ''} → ${filename}`;
    };
    const blocked = result.skipped.filter((s) => s.needsPermission).length;
    offerSiteAccess(result.skipped);
    if (blocked) {
      // Don't silently save an incomplete PDF: let the user allow access or accept the gap.
      $('#pdfStatus').textContent = `다른 사이트 이미지 ${blocked}장을 읽을 권한이 없어 PDF를 아직 저장하지 않았습니다.`;
      const partial = $('#pdfSavePartial');
      partial.hidden = !result.blob;
      partial.textContent = `제외하고 저장 (${result.included}장)`;
      partial.onclick = save;
      return;
    }
    if (!result.blob) {
      $('#pdfStatus').textContent = 'PDF를 만들지 못했습니다: 넣을 수 있는 이미지가 없습니다.';
      return;
    }
    await save();
  } catch (e) {
    $('#pdfStatus').textContent = e?.name === 'AbortError' ? 'PDF 만들기를 취소했습니다.' : `PDF를 만들지 못했습니다: ${e?.message || e}`;
  } finally {
    pdfRunning = false;
    render();
  }
});
/**
 * Images on another site (e.g. an image CDN) can only go into a PDF with access
 * to that site. Offer exactly those origins, not every site.
 */
function offerSiteAccess(skipped) {
  const btn = $('#pdfGrant');
  const origins = [...new Set(skipped.filter((s) => s.needsPermission).map((s) => { try { return new URL(s.url).origin; } catch { return null; } }).filter(Boolean))];
  btn.hidden = !origins.length;
  if (!origins.length) return;
  btn.textContent = `${origins.map((o) => new URL(o).host).join(', ')} 접근 허용 후 다시 만들기`;
  btn.onclick = async () => {
    const granted = await chrome.permissions.request({ origins: origins.map((o) => `${o}/*`) }).catch(() => false);
    if (!granted) return toast('권한을 허용하지 않아 다른 사이트 이미지는 PDF에 넣을 수 없습니다.');
    setCredentialPolicy(hostAccessPolicy()); // forget cached "no access" answers
    btn.hidden = true;
    $('#btnPdf').click();
  };
}

$('#pdfCancel').addEventListener('click', () => {
  if (pdfRunning) pdfAbort?.abort();
  else $('#pdfPanel').hidden = true;
});

$('#pdfLayout').value = settings.pdfLayout;
$('#pdfLayout').addEventListener('change', async (e) => {
  settings = await saveSettings({ pdfLayout: e.target.value });
});

// ---------------------------------------------------------------- other views
const pasteView = initPasteView({ getSettings: () => settings, probe, enqueue });
initDownloadsView({
  getSettings: () => settings,
  onJobs(jobs) {
    // Latest job per page item, shown on its card.
    const byItem = new Map();
    for (const j of jobs) if (j.itemKey && (!byItem.has(j.itemKey) || byItem.get(j.itemKey).id < j.id)) byItem.set(j.itemKey, j);
    state.jobsByItem = byItem;
    pasteView.onJobs(jobs);
    render();
  },
});

// ---------------------------------------------------------------- start
showPage();
render();
if (state.tabId) scan({ scroll: !!settings.scrollOnOpen });
else if (params.get('view')) showView(params.get('view'));
