import { $, command, h, rafThrottle, saveTextFile, STATUS_LABEL, timestamp, toast } from './common.js';
import { badges, dimsText, displayName } from './item-format.js';
import { createViewer } from './viewer.js';
import { initPasteView } from './paste-view.js';
import { collectImages, autoScroll } from '../content/collector.js';
import { createProber, decodeWithImage, measureFullSize } from '../lib/probe.js';
import { resolveEntry, mergeItem, buildCandidates } from '../lib/resolver.js';
import { ALL_FORMATS, applyFilters, formatBytes, formatKey, SORT_LABELS, sortItems } from '../lib/filters.js';
import { buildFolder } from '../lib/filename.js';
import { hostOf } from '../lib/url-utils.js';
import { loadSettings, saveSettings } from '../lib/settings.js';

let settings = await loadSettings();
const probe = createProber({ decode: decodeWithImage, concurrency: 8 });

// ---------------------------------------------------------------- state
const state = {
  tabId: Number(new URLSearchParams(location.search).get('tabId')) || null,
  page: null, // { url, title }
  items: new Map(), // originalKey -> item
  pending: 0,
  resolved: 0,
  seenEntries: new Set(),
  nextOrder: 0,
  selected: new Set(),
  scanning: false,
  scanGen: 0,
};
const cards = new Map();

// ---------------------------------------------------------------- views
for (const tab of document.querySelectorAll('.tab')) {
  tab.addEventListener('click', () => {
    if ($('#viewer') && !$('#viewer').hidden) return;
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === tab));
    document.querySelectorAll('.view').forEach((v) => (v.hidden = v.id !== `view-${tab.dataset.view}`));
  });
}
const showView = (name) => document.querySelector(`.tab[data-view="${name}"]`).click();

// ---------------------------------------------------------------- filters UI
const filterState = { formats: new Set(ALL_FORMATS) };
$('#fFormats').append(
  ...ALL_FORMATS.map((f) =>
    h('button', {
      class: 'chip on',
      dataset: { f },
      onclick: (e) => {
        filterState.formats.has(f) ? filterState.formats.delete(f) : filterState.formats.add(f);
        e.target.classList.toggle('on', filterState.formats.has(f));
        render();
      },
    }, f === 'OTHER' ? '기타' : f),
  ),
);
$('#sortKey').append(...Object.entries(SORT_LABELS).map(([k, v]) => h('option', { value: k }, v)));
for (const id of ['fMinW', 'fMinH', 'fMinSize', 'fSizeUnit', 'fUnknownSize', 'fNoThumb', 'fUnsure', 'sortKey']) {
  $('#' + id).addEventListener('input', () => render());
}
$('#sortDir').addEventListener('click', (e) => {
  const b = e.currentTarget;
  b.dataset.dir = b.dataset.dir === 'asc' ? 'desc' : 'asc';
  b.textContent = b.dataset.dir === 'asc' ? '오름차순 ↑' : '내림차순 ↓';
  render();
});

function currentFilters() {
  const num = (id) => Math.max(0, Number($('#' + id).value) || 0);
  return {
    minWidth: num('fMinW'),
    minHeight: num('fMinH'),
    minBytes: num('fMinSize') * Number($('#fSizeUnit').value),
    includeUnknownSize: $('#fUnknownSize').checked,
    formats: filterState.formats.size === ALL_FORMATS.length ? null : [...filterState.formats],
    excludeThumbnails: $('#fNoThumb').checked,
    onlyUnsure: $('#fUnsure').checked,
  };
}

/** The list as currently filtered and sorted: shared by the grid and the viewer. */
function visibleList() {
  const all = [...state.items.values()];
  const { items, hiddenUnknownSize } = applyFilters(all, currentFilters());
  const sorted = sortItems(items, $('#sortKey').value, $('#sortDir').dataset.dir);
  return { list: sorted, total: all.length, hiddenUnknownSize };
}

// ---------------------------------------------------------------- grid
function cardFor(item) {
  let c = cards.get(item.id);
  if (!c) {
    const pick = h('input', { type: 'checkbox', class: 'pick', title: '선택' });
    const img = h('img', { loading: 'lazy', alt: '', referrerPolicy: 'no-referrer-when-downgrade' });
    const thumb = h('div', { class: 'thumb', title: '클릭하면 원본 순차 보기' }, img);
    const dims = h('div', { class: 'dims' });
    const badgeBox = h('div', { class: 'badges' });
    const name = h('div', { class: 'name' });
    const el = h('div', { class: 'card' }, pick, thumb, h('div', { class: 'meta' }, dims, badgeBox, name));
    pick.addEventListener('click', (e) => onPick(item.id, e));
    thumb.addEventListener('click', () => viewer.open(item.id));
    img.addEventListener('error', () => {
      // The page's small version failed (e.g. expired); fall back to the original.
      const it = state.items.get(item.id);
      if (it && img.src !== it.originalUrl) img.src = it.originalUrl;
    }, { once: true });
    c = { el, pick, img, dims, badgeBox, name, sig: '' };
    cards.set(item.id, c);
  }
  const sig = [item.width, item.height, item.format, item.bytes, item.confidenceLabel, item.originalStatus, item.isThumbnail, item.sourceType, item.originalUrl].join('|');
  if (sig !== c.sig) {
    c.sig = sig;
    const preview = item.displayUrl && !item.displayUrl.startsWith('data:') ? item.displayUrl : item.originalUrl;
    if (c.img.getAttribute('src') !== preview) c.img.src = preview;
    c.dims.textContent = dimsText(item);
    c.badgeBox.replaceChildren(...badges(item));
    c.name.textContent = displayName(item);
    c.name.title = item.originalUrl;
  }
  const sel = state.selected.has(item.id);
  c.pick.checked = sel;
  c.el.classList.toggle('selected', sel);
  return c.el;
}

let lastPicked = null;
let lastList = [];
function onPick(id, e) {
  const on = e.target.checked;
  if (e.shiftKey && lastPicked) {
    // Shift-click selects/deselects the whole range in the current order.
    const a = lastList.findIndex((x) => x.id === lastPicked);
    const b = lastList.findIndex((x) => x.id === id);
    if (a >= 0 && b >= 0) {
      for (const it of lastList.slice(Math.min(a, b), Math.max(a, b) + 1)) on ? state.selected.add(it.id) : state.selected.delete(it.id);
    }
  } else {
    on ? state.selected.add(id) : state.selected.delete(id);
  }
  lastPicked = id;
  render();
}

const render = rafThrottle(() => {
  const { list, total, hiddenUnknownSize } = visibleList();
  lastList = list;
  $('#grid').replaceChildren(...list.map(cardFor));
  const selected = state.selected.size;
  const visibleIds = new Set(list.map((x) => x.id));
  const hiddenSelected = [...state.selected].filter((id) => !visibleIds.has(id)).length;
  $('#countLine').replaceChildren(
    `표시 ${list.length} / 전체 ${total} · 선택 ${selected}`,
    h('small', {}, [
      hiddenSelected ? ` (필터로 숨겨진 선택 ${hiddenSelected}개 포함)` : '',
      hiddenUnknownSize ? ` · 크기 미확인 ${hiddenUnknownSize}개 제외됨` : '',
    ].join('')),
  );
  $('#btnDownload').textContent = `선택 다운로드 (${selected})`;
  $('#btnDownload').disabled = !selected;
  const empty = $('#emptyMsg');
  empty.hidden = list.length > 0 || state.scanning;
  empty.textContent = total ? '현재 필터에 맞는 이미지가 없습니다.' : state.tabId ? '찾은 이미지가 없습니다.' : '분석할 탭을 선택하세요.';
  viewer.refresh();
});

// ---------------------------------------------------------------- selection
$('#btnSelectAll').addEventListener('click', () => { for (const id of state.items.keys()) state.selected.add(id); render(); });
$('#btnSelectNone').addEventListener('click', () => { state.selected.clear(); render(); });
$('#btnSelectFiltered').addEventListener('click', () => {
  state.selected = new Set(visibleList().list.map((x) => x.id));
  render();
});

// ---------------------------------------------------------------- scanning
async function populateTabs() {
  const tabs = await chrome.tabs.query({});
  const own = chrome.runtime.getURL('');
  const usable = tabs.filter((t) => /^(https?|file):/.test(t.url || '') && !t.url.startsWith(own));
  const sel = $('#tabSelect');
  sel.replaceChildren(
    h('option', { value: '' }, usable.length ? '— 탭을 선택하세요 —' : '분석할 수 있는 탭이 없습니다'),
    ...usable.map((t) => h('option', { value: t.id, selected: t.id === state.tabId }, `${t.title || t.url} — ${hostOf(t.url)}`)),
  );
}

$('#tabSelect').addEventListener('change', (e) => {
  state.tabId = Number(e.target.value) || null;
  history.replaceState(null, '', state.tabId ? `?tabId=${state.tabId}` : '?');
  resetResults();
  if (state.tabId) scan();
});

function resetResults() {
  state.scanGen++;
  state.items.clear();
  state.selected.clear();
  state.seenEntries.clear();
  state.nextOrder = 0;
  state.pending = state.resolved = 0;
  cards.clear();
  render();
}

function setStatus(text) {
  $('#scanStatus').textContent = text;
}

async function scan({ scroll = false } = {}) {
  if (!state.tabId || state.scanning) return;
  state.scanning = true;
  const gen = state.scanGen;
  $('#btnScan').disabled = $('#btnScrollScan').disabled = true;
  try {
    if (scroll) {
      setStatus('페이지를 끝까지 스크롤하며 지연 로딩 이미지를 불러오는 중…');
      // Background tabs don't render, so lazy loaders (IntersectionObserver) never fire.
      // Show the page while scrolling, then come back here.
      const me = await chrome.tabs.getCurrent();
      const target = await chrome.tabs.get(state.tabId);
      await chrome.tabs.update(state.tabId, { active: true });
      await chrome.windows.update(target.windowId, { focused: true }).catch(() => {});
      try {
        await chrome.scripting.executeScript({ target: { tabId: state.tabId }, func: autoScroll, args: [{}] });
      } finally {
        await chrome.tabs.update(me.id, { active: true });
        await chrome.windows.update(me.windowId, { focused: true }).catch(() => {});
      }
    }
    setStatus('이미지를 찾는 중…');
    const results = await chrome.scripting.executeScript({
      target: { tabId: state.tabId, allFrames: true },
      func: collectImages,
      args: [{}],
    });
    if (gen !== state.scanGen) return;
    results.sort((a, b) => (a.frameId === 0 ? -1 : b.frameId === 0 ? 1 : a.frameId - b.frameId));
    const main = results.find((r) => r.frameId === 0)?.result;
    if (main) {
      state.page = { url: main.pageUrl, title: main.title };
      document.title = `Image Hunter — ${main.title || hostOf(main.pageUrl)}`;
    }
    const fresh = [];
    for (const r of results) {
      if (!r.result) continue;
      for (const e of r.result.entries) {
        const key = e.candidates.map((c) => c.url).sort().join('|');
        if (state.seenEntries.has(key)) continue;
        state.seenEntries.add(key);
        fresh.push({ ...e, order: state.nextOrder++, pageUrl: main?.pageUrl || r.result.pageUrl, frameUrl: r.result.pageUrl });
      }
    }
    await resolveEntries(fresh, gen);
  } catch (e) {
    setStatus(`분석할 수 없는 페이지입니다: ${e.message || e}`);
    return;
  } finally {
    state.scanning = false;
    $('#btnScan').disabled = $('#btnScrollScan').disabled = false;
    render();
  }
}

async function resolveEntries(entries, gen) {
  if (!entries.length) {
    setStatus(`새로 찾은 이미지가 없습니다. 현재 ${state.items.size}개.`);
    return;
  }
  // Images and probes are requested by this tab: tell the worker which Referer to use.
  if (settings.setReferer && state.page) {
    const hosts = new Set();
    for (const e of entries) for (const c of buildCandidates(e)) if (/^https?:/.test(c.url)) hosts.add(hostOf(c.url));
    await command('setReferers', { scope: 'tab', pairs: [...hosts].map((host) => ({ host, referer: state.page.url })) }).catch(() => {});
  }
  state.pending += entries.length;
  const opts = { thumbMaxSide: settings.thumbMaxSide, maxVariants: 6 };
  const progress = () => setStatus(`원본 판별 중… ${state.resolved} / ${state.pending} (실제 해상도 확인)`);
  progress();
  await Promise.all(
    entries.map(async (entry) => {
      const item = await resolveEntry(entry, probe, opts);
      if (gen !== state.scanGen) return;
      mergeItem(state.items, item);
      state.resolved++;
      progress();
      render();
    }),
  );
  if (gen !== state.scanGen) return;
  const all = [...state.items.values()];
  const found = all.filter((i) => i.originalStatus === 'found').length;
  const unsure = all.filter((i) => i.confidenceLabel === '확인 필요').length;
  setStatus(`이미지 ${all.length}개 (페이지 항목 ${state.resolved}개에서 중복 제거) · 더 큰 원본 발견 ${found}개 · 확인 필요 ${unsure}개`);
}

$('#btnScan').addEventListener('click', () => scan());
$('#btnScrollScan').addEventListener('click', () => scan({ scroll: true }));

// ---------------------------------------------------------------- file size measuring
$('#btnMeasure').addEventListener('click', async () => {
  const unknown = visibleList().list.filter((i) => i.bytes == null && !i.originalUrl.startsWith('data:'));
  if (!unknown.length) return toast('크기를 측정할 항목이 없습니다.');
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
      btn.textContent = `측정 중 ${++done}/${unknown.length}`;
      render();
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  btn.textContent = '미확인 크기 측정';
  btn.disabled = false;
  toast(`크기 측정 완료: ${unknown.length - failed}개 성공${failed ? `, ${failed}개 실패` : ''}`);
});

// ---------------------------------------------------------------- downloading
async function enqueue(list) {
  return command('enqueue', { items: list, settings: { conflictAction: settings.conflictAction, concurrency: settings.concurrency } });
}

async function downloadItems(items) {
  if (!items.length) return toast('선택한 이미지가 없습니다.');
  const site = state.page?.url || '';
  await enqueue(
    items.map((it) => ({
      url: it.originalUrl,
      referer: settings.setReferer ? site : '',
      folder: buildFolder(settings, site),
      format: it.format,
      bytes: it.bytes,
      group: 'page',
    })),
  );
  toast(`${items.length}개 이미지를 다운로드 대기열에 추가했습니다.`);
}

$('#btnDownload').addEventListener('click', () => {
  // Keep the on-screen order so auto-generated names (image_001…) follow it.
  const { list } = visibleList();
  const visibleSel = list.filter((x) => state.selected.has(x.id));
  const visibleIds = new Set(visibleSel.map((x) => x.id));
  const hiddenSel = [...state.selected].filter((id) => !visibleIds.has(id)).map((id) => state.items.get(id)).filter(Boolean);
  downloadItems([...visibleSel, ...sortItems(hiddenSel, 'order')]);
});

// ---------------------------------------------------------------- viewer
const viewer = createViewer({
  getList: () => visibleList().list,
  isSelected: (id) => state.selected.has(id),
  setSelected: (id, on) => {
    on ? state.selected.add(id) : state.selected.delete(id);
    render();
  },
  download: downloadItems,
  getExcludeThumbs: () => $('#fNoThumb').checked,
  setExcludeThumbs: (on) => {
    $('#fNoThumb').checked = on;
    render();
  },
  getAutoSkip: () => settings.autoSkipFailed,
  setAutoSkip: async (on) => {
    settings = await saveSettings({ autoSkipFailed: on });
    $('#sAutoSkip').checked = on;
  },
  onLoaded: (item, w, hgt) => {
    // The viewer decoded the full image: fill in a resolution we could not read before.
    if (!item.width && w) {
      Object.assign(item, { width: w, height: hgt });
      render();
    }
  },
});
$('#btnViewer').addEventListener('click', () => {
  const { list } = visibleList();
  const firstSel = list.find((x) => state.selected.has(x.id));
  viewer.open((firstSel || list[0])?.id);
});

// ---------------------------------------------------------------- downloads view
let downloads = [];
const port = chrome.runtime.connect({ name: 'ih-downloads' });
const dlRows = new Map();

const pasteView = initPasteView({
  getSettings: () => settings,
  probe,
  enqueue,
  analyzeUrl: async (url) => {
    const tab = await chrome.tabs.create({ url, active: false });
    const listener = (id, info) => {
      if (id === tab.id && info.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        chrome.tabs.create({ url: chrome.runtime.getURL(`app/app.html?tabId=${tab.id}`) });
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
    toast('페이지를 연 뒤 새 분석 탭을 엽니다…');
  },
});

port.onMessage.addListener((msg) => {
  if (msg.type !== 'downloads') return;
  downloads = msg.items;
  renderDownloads();
  pasteView.onDownloads(downloads);
});

function renderDownloads() {
  const counts = {};
  for (const d of downloads) counts[d.status] = (counts[d.status] || 0) + 1;
  const active = (counts.queued || 0) + (counts.starting || 0) + (counts.in_progress || 0);
  const badge = $('#dlBadge');
  badge.hidden = !active && !counts.failed;
  badge.textContent = active || counts.failed || '';
  badge.style.background = !active && counts.failed ? 'var(--bad)' : '';
  $('#dlSummary').textContent = downloads.length
    ? `전체 ${downloads.length} · ` + ['queued', 'in_progress', 'complete', 'failed', 'cancelled'].map((s) => `${STATUS_LABEL[s]} ${(s === 'in_progress' ? (counts.in_progress || 0) + (counts.starting || 0) : counts[s]) || 0}`).join(' · ')
    : '';
  $('#dlEmpty').hidden = downloads.length > 0;
  $('#dlTable').hidden = !downloads.length;

  const tbody = $('#dlTable tbody');
  const live = new Set();
  const rows = [...downloads].reverse().map((d) => {
    live.add(d.id);
    let r = dlRows.get(d.id);
    if (!r) {
      r = { tr: h('tr'), sig: '' };
      dlRows.set(d.id, r);
    }
    const sig = [d.status, d.bytesReceived, d.totalBytes, d.filename, d.error].join('|');
    if (sig !== r.sig) {
      r.sig = sig;
      r.tr.replaceChildren(...downloadCells(d));
    }
    return r.tr;
  });
  for (const id of dlRows.keys()) if (!live.has(id)) dlRows.delete(id);
  tbody.replaceChildren(...rows);
}

function downloadCells(d) {
  const name = d.filename ? d.filename.split('/').slice(1).join('/') : d.customName || '(파일명 결정 전)';
  const pct = d.status === 'complete' ? 100 : d.totalBytes ? Math.min(100, Math.round((d.bytesReceived / d.totalBytes) * 100)) : 0;
  const bytes = d.totalBytes ? `${formatBytes(d.bytesReceived)} / ${formatBytes(d.totalBytes)}` : d.bytesReceived ? formatBytes(d.bytesReceived) : '';
  const actions = [];
  if (d.status === 'failed' || d.status === 'cancelled') actions.push(h('button', { class: 'btn small', onclick: () => command('retry', { ids: [d.id] }) }, '재시도'));
  if (['queued', 'starting', 'in_progress'].includes(d.status)) actions.push(h('button', { class: 'btn small', onclick: () => command('cancel', { ids: [d.id] }) }, '취소'));
  return [
    h('td', { class: 'url', title: `${d.url}\n→ ${d.savedPath || d.filename || ''}` }, h('div', {}, name), h('div', { class: 'pbytes' }, d.url.startsWith('data:') ? '(data URL)' : d.url)),
    h('td', {}, h('span', { class: `st ${d.status}` }, STATUS_LABEL[d.status] || d.status)),
    h('td', { class: 'c-progress' },
      h('div', { class: `progress ${d.status === 'complete' ? 'done' : d.status === 'failed' ? 'failed' : ''}` }, h('div', { style: `width:${pct}%` })),
      h('div', { class: 'pbytes' }, `${pct}%${bytes ? ' · ' + bytes : ''}`)),
    h('td', { class: 'err' }, d.error || ''),
    h('td', {}, ...actions),
  ];
}

$('#dlRetryFailed').addEventListener('click', () => command('retry', {}));
$('#dlCancelAll').addEventListener('click', () => command('cancel', {}));
$('#dlClear').addEventListener('click', () => command('clear', { statuses: ['complete', 'cancelled'] }));
$('#dlOpenFolder').addEventListener('click', () => chrome.downloads.showDefaultFolder());
$('#dlExport').addEventListener('click', async () => {
  const failed = downloads.filter((d) => d.status === 'failed');
  if (!failed.length) return toast('실패한 다운로드가 없습니다.');
  const text = failed.map((d) => `# ${d.error || '실패'}\n${d.url}`).join('\n') + '\n';
  await navigator.clipboard.writeText(text).catch(() => {});
  await saveTextFile(`${settings.rootFolder || 'Image Hunter'}/failed_urls_${timestamp()}.txt`, text);
  toast(`실패 목록 ${failed.length}개를 저장하고 클립보드에 복사했습니다. URL 붙여넣기 화면에 그대로 붙여넣어 재시도할 수 있습니다.`, 4000);
});

// ---------------------------------------------------------------- settings view
function fillSettings() {
  $('#sRoot').value = settings.rootFolder;
  $('#sPerSite').checked = settings.perSiteFolder;
  $('#sConflict').value = settings.conflictAction;
  $('#sConcurrency').value = settings.concurrency;
  $('#sReferer').checked = settings.setReferer;
  $('#sThumb').value = settings.thumbMaxSide;
  $('#sAutoSkip').checked = settings.autoSkipFailed;
}
fillSettings();
document.querySelector('#view-settings').addEventListener('change', async () => {
  settings = await saveSettings({
    rootFolder: $('#sRoot').value.trim() || 'Image Hunter',
    perSiteFolder: $('#sPerSite').checked,
    conflictAction: $('#sConflict').value,
    concurrency: Math.min(8, Math.max(1, Number($('#sConcurrency').value) || 3)),
    setReferer: $('#sReferer').checked,
    thumbMaxSide: Math.max(16, Number($('#sThumb').value) || 300),
    autoSkipFailed: $('#sAutoSkip').checked,
  });
  fillSettings();
  $('#settingsSaved').textContent = '저장되었습니다. 썸네일 기준 변경은 다음 탐색부터 적용됩니다.';
});

// ---------------------------------------------------------------- start
await populateTabs();
render();
if (state.tabId) scan();
else if (new URLSearchParams(location.search).get('view') === 'paste') showView('paste');
