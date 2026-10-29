// Service worker: opens the analyser, runs the download queue and keeps
// Referer rules so hot-link-protected images load and download.

import { NameRegistry, decideFilename } from './lib/filename.js';
import { hostOf, urlBasename } from './lib/url-utils.js';
import { httpError } from './lib/probe.js';

const STATUS = { QUEUED: 'queued', STARTING: 'starting', ACTIVE: 'in_progress', DONE: 'complete', FAILED: 'failed', CANCELLED: 'cancelled' };

const INTERRUPT_REASONS = {
  FILE_FAILED: '파일 저장 실패', FILE_ACCESS_DENIED: '저장 위치 접근 거부', FILE_NO_SPACE: '디스크 공간 부족',
  FILE_NAME_TOO_LONG: '파일명이 너무 김', FILE_TOO_LARGE: '파일이 너무 큼', FILE_VIRUS_INFECTED: '바이러스 검사에서 차단됨',
  FILE_TRANSIENT_ERROR: '일시적인 파일 오류', FILE_BLOCKED: '보안 정책으로 차단됨', FILE_SECURITY_CHECK_FAILED: '보안 검사 실패',
  FILE_TOO_SHORT: '파일이 불완전함', FILE_HASH_MISMATCH: '파일 해시 불일치', FILE_SAME_AS_SOURCE: '원본과 같은 파일',
  NETWORK_FAILED: '네트워크 오류', NETWORK_TIMEOUT: '네트워크 시간 초과', NETWORK_DISCONNECTED: '인터넷 연결 끊김',
  NETWORK_SERVER_DOWN: '서버 응답 없음', NETWORK_INVALID_REQUEST: '잘못된 요청', SERVER_FAILED: '서버 오류',
  SERVER_NO_RANGE: '서버가 이어받기를 지원하지 않음', SERVER_BAD_CONTENT: '서버가 파일을 제공하지 않음 (404 등)',
  SERVER_UNAUTHORIZED: '인증 필요 (401)', SERVER_CERT_PROBLEM: '인증서 문제', SERVER_FORBIDDEN: '접근 거부 (403)',
  SERVER_UNREACHABLE: '서버에 연결할 수 없음', SERVER_CONTENT_LENGTH_MISMATCH: '전송 크기 불일치',
  SERVER_CROSS_ORIGIN_REDIRECT: '다른 사이트로 리디렉션됨', USER_SHUTDOWN: '브라우저 종료로 중단', CRASH: '브라우저 오류로 중단',
};

let items = []; // download jobs
let nextId = 1;
let registry = new NameRegistry();
let settings = { conflictAction: 'uniquify', concurrency: 3 };
const byDownloadId = new Map();
const ports = new Set();
// data: URL -> file name for plain saves (e.g. the failed-URL list). Not persisted.
const namedSaves = new Map();

const ready = (async () => {
  const saved = await chrome.storage.session.get(['dlState']);
  const s = saved.dlState;
  if (s) {
    items = s.items || [];
    nextId = s.nextId || 1;
    registry = new NameRegistry(s.registry);
    settings = s.settings || settings;
    for (const it of items) {
      if (it.status === STATUS.STARTING) Object.assign(it, { status: STATUS.FAILED, error: '확장 프로그램이 재시작되어 중단됨 — 재시도하세요' });
      if (it.downloadId != null) byDownloadId.set(it.downloadId, it);
    }
  }
  pump();
})();

// ---- persistence & broadcast ---------------------------------------------

let saveTimer = null;
let broadcastTimer = null;
function changed() {
  if (!saveTimer) {
    saveTimer = setTimeout(() => {
      saveTimer = null;
      chrome.storage.session.set({ dlState: { items: items.map(({ dataUrl, ...rest }) => rest), nextId, registry: registry.toJSON(), settings } });
    }, 300);
  }
  if (!broadcastTimer) {
    broadcastTimer = setTimeout(() => {
      broadcastTimer = null;
      const msg = { type: 'downloads', items: items.map(({ dataUrl, ...rest }) => rest) };
      for (const p of ports) p.postMessage(msg);
    }, 150);
  }
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'ih-downloads') return;
  ports.add(port);
  ready.then(() => port.postMessage({ type: 'downloads', items }));
  port.onDisconnect.addListener(() => ports.delete(port));
});

// ---- opening the analyser --------------------------------------------------

chrome.action.onClicked.addListener((tab) => {
  const params = new URLSearchParams();
  if (tab?.id != null && /^https?:|^file:/.test(tab.url || '')) params.set('tabId', tab.id);
  chrome.tabs.create({ url: chrome.runtime.getURL(`app/app.html?${params}`), index: (tab?.index ?? -1) + 1, openerTabId: tab?.id });
});

// ---- commands from the app page -------------------------------------------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  ready
    .then(() => handle(msg, sender))
    .then((r) => sendResponse({ ok: true, ...r }), (e) => sendResponse({ ok: false, error: String(e?.message || e) }));
  return true;
});

async function handle(msg, sender) {
  switch (msg.type) {
    case 'enqueue': {
      if (msg.settings) settings = { ...settings, ...msg.settings };
      const ids = msg.items.map((x) => {
        const it = {
          id: nextId++,
          url: x.url,
          referer: x.referer || '',
          folder: x.folder,
          customName: x.customName || '',
          formatHint: x.format || null,
          group: x.group || '',
          status: STATUS.QUEUED,
          bytesReceived: 0,
          totalBytes: x.bytes || 0,
          filename: '',
          error: null,
          createdAt: Date.now(),
        };
        items.push(it);
        return it.id;
      });
      changed();
      pump();
      return { ids };
    }
    case 'retry': {
      const ids = new Set(msg.ids || items.filter((i) => i.status === STATUS.FAILED).map((i) => i.id));
      for (const it of items) {
        if (ids.has(it.id) && (it.status === STATUS.FAILED || it.status === STATUS.CANCELLED)) {
          if (it.filename) registry.release(it.folder, it.filename.split('/').pop());
          if (it.downloadId != null) byDownloadId.delete(it.downloadId);
          Object.assign(it, { status: STATUS.QUEUED, error: null, bytesReceived: 0, downloadId: null, filename: '', viaFetch: false });
        }
      }
      changed();
      pump();
      return {};
    }
    case 'cancel': {
      const ids = msg.ids ? new Set(msg.ids) : null;
      for (const it of items) {
        if (ids && !ids.has(it.id)) continue;
        if (it.status === STATUS.QUEUED) it.status = STATUS.CANCELLED;
        else if ((it.status === STATUS.ACTIVE || it.status === STATUS.STARTING) && it.downloadId != null) {
          await chrome.downloads.cancel(it.downloadId).catch(() => {});
          it.status = STATUS.CANCELLED;
        }
      }
      changed();
      pump();
      return {};
    }
    case 'clear': {
      const statuses = new Set(msg.statuses || [STATUS.DONE, STATUS.CANCELLED]);
      items = items.filter((it) => !statuses.has(it.status));
      changed();
      return {};
    }
    case 'setReferers': {
      // Scope: the requesting tab (app page previews/probes) or tab-less requests (downloads).
      const tabId = msg.scope === 'downloads' ? -1 : sender.tab?.id;
      if (tabId == null) return {};
      await setRefererRules(tabId, msg.pairs || []);
      return {};
    }
    case 'saveText': {
      const url = 'data:text/plain;charset=utf-8,' + encodeURIComponent('﻿' + msg.text);
      namedSaves.set(url, msg.filename);
      await chrome.downloads.download({ url, saveAs: false, conflictAction: 'uniquify' });
      return {};
    }
    case 'snapshot':
      return { items };
    default:
      throw new Error(`unknown command ${msg.type}`);
  }
}

// ---- queue ---------------------------------------------------------------

function pump() {
  const busy = items.filter((i) => i.status === STATUS.ACTIVE || i.status === STATUS.STARTING).length;
  let free = Math.max(1, Number(settings.concurrency) || 3) - busy;
  for (const it of items) {
    if (free <= 0) break;
    if (it.status !== STATUS.QUEUED) continue;
    free--;
    start(it);
  }
  ensurePolling();
}

async function start(it) {
  it.status = STATUS.STARTING;
  changed();
  try {
    if (it.referer && /^https?:/.test(it.url)) {
      await setRefererRules(-1, [{ host: hostOf(it.url), referer: it.referer }]);
    }
    const downloadId = await chrome.downloads.download({ url: it.url, conflictAction: settings.conflictAction, saveAs: false });
    if (it.status === STATUS.CANCELLED) {
      chrome.downloads.cancel(downloadId).catch(() => {});
      return;
    }
    it.downloadId = downloadId;
    byDownloadId.set(downloadId, it);
    if (it.status === STATUS.STARTING) it.status = STATUS.ACTIVE;
    // The download may have finished before we got its id.
    const [d] = await chrome.downloads.search({ id: downloadId });
    if (d) applyDownloadState(it, d);
  } catch (e) {
    Object.assign(it, { status: STATUS.FAILED, error: `다운로드를 시작할 수 없음: ${e?.message || e}` });
  }
  changed();
  pump();
}

// Chrome asks us for the file name once it knows the server's name and MIME type.
// While this listener exists Chrome ignores downloads.download({ filename }),
// so every download this extension starts must be named here.
chrome.downloads.onDeterminingFilename.addListener((d, suggest) => {
  const named = namedSaves.get(d.url);
  if (named) {
    namedSaves.delete(d.url);
    suggest({ filename: named, conflictAction: 'uniquify' });
    return;
  }
  const it =
    byDownloadId.get(d.id) ||
    items.find((x) => x.status === STATUS.STARTING && x.downloadId == null && (x.url === d.url || x.url === d.finalUrl)) ||
    items.find((x) => x.dataUrl && x.downloadId == null && x.dataUrl === d.url);
  if (!it) return; // not ours: Chrome keeps its default
  if (it.downloadId == null) {
    it.downloadId = d.id;
    byDownloadId.set(d.id, it);
  }
  const name = decideFilename({
    customName: it.customName,
    serverName: it.viaFetch ? it.serverName : d.filename,
    mime: it.viaFetch ? it.mime : d.mime,
    format: it.formatHint,
    folder: it.folder,
    registry,
  });
  it.filename = `${it.folder}/${name}`;
  changed();
  suggest({ filename: it.filename, conflictAction: settings.conflictAction });
});

chrome.downloads.onChanged.addListener(async (delta) => {
  await ready;
  const it = byDownloadId.get(delta.id);
  if (!it) return;
  const [d] = await chrome.downloads.search({ id: delta.id });
  if (d) applyDownloadState(it, d);
  changed();
  pump();
});

function applyDownloadState(it, d) {
  it.bytesReceived = d.bytesReceived;
  if (d.totalBytes > 0) it.totalBytes = d.totalBytes;
  if (d.filename) it.savedPath = d.filename;
  if (d.state === 'complete') {
    it.status = STATUS.DONE;
    it.bytesReceived = it.totalBytes = d.fileSize || d.bytesReceived;
  } else if (d.state === 'interrupted') {
    if (d.error === 'USER_CANCELED') {
      it.status = STATUS.CANCELLED;
    } else if (FALLBACK_ERRORS.has(d.error) && it.referer && !it.viaFetch && it.status !== STATUS.STARTING) {
      // Hot-link protection: retry through fetch, where the Referer rule applies.
      it.status = STATUS.STARTING;
      it.viaFetch = true;
      byDownloadId.delete(d.id);
      it.downloadId = null;
      if (it.filename) registry.release(it.folder, it.filename.split('/').pop());
      it.filename = '';
      startViaFetch(it);
    } else {
      it.status = STATUS.FAILED;
      it.error = INTERRUPT_REASONS[d.error] || d.error || '알 수 없는 오류';
    }
  } else if (it.status !== STATUS.CANCELLED) {
    it.status = STATUS.ACTIVE;
  }
}

// chrome.downloads requests are invisible to declarativeNetRequest, so a Referer
// can't be added to them. For refused downloads the worker fetches the file
// itself (its requests do get the rule) and saves it from a data: URL.
const FALLBACK_ERRORS = new Set(['SERVER_FORBIDDEN', 'SERVER_UNAUTHORIZED', 'SERVER_BAD_CONTENT', 'NETWORK_INVALID_REQUEST']);

async function startViaFetch(it) {
  changed();
  try {
    await setRefererRules(-1, [{ host: hostOf(it.url), referer: it.referer }]);
    const resp = await fetch(it.url, { credentials: 'include' });
    if (!resp.ok) throw new Error(httpError(resp.status));
    it.status = STATUS.ACTIVE;
    it.totalBytes = Number(resp.headers.get('content-length')) || it.totalBytes || 0;
    const chunks = [];
    const reader = resp.body.getReader();
    it.bytesReceived = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (it.status === STATUS.CANCELLED) return reader.cancel();
      chunks.push(value);
      it.bytesReceived += value.length;
      changed();
    }
    it.mime = (resp.headers.get('content-type') || '').split(';')[0];
    it.serverName = filenameFromDisposition(resp.headers.get('content-disposition')) || urlBasename(resp.url || it.url);
    const dataUrl = await blobToDataUrl(new Blob(chunks, { type: it.mime || 'application/octet-stream' }));
    it.dataUrl = dataUrl;
    const downloadId = await chrome.downloads.download({ url: dataUrl, conflictAction: settings.conflictAction, saveAs: false });
    it.downloadId = downloadId;
    byDownloadId.set(downloadId, it);
    const [d] = await chrome.downloads.search({ id: downloadId });
    if (d) applyDownloadState(it, d);
  } catch (e) {
    Object.assign(it, { status: STATUS.FAILED, error: String(e?.message || e) });
  }
  delete it.dataUrl;
  changed();
  pump();
}

function filenameFromDisposition(h) {
  if (!h) return '';
  const star = /filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/.exec(h);
  if (star) {
    try {
      return decodeURIComponent(star[1].trim());
    } catch { /* fall through */ }
  }
  const m = /filename\s*=\s*"?([^";]+)"?/i.exec(h);
  return m ? m[1].trim() : '';
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

// onChanged does not report byte progress, so active downloads are polled.
let pollTimer = null;
function ensurePolling() {
  const active = () => items.filter((i) => i.status === STATUS.ACTIVE && i.downloadId != null);
  if (pollTimer || !active().length) return;
  pollTimer = setInterval(async () => {
    const list = active();
    if (!list.length) {
      clearInterval(pollTimer);
      pollTimer = null;
      return;
    }
    for (const it of list) {
      const [d] = await chrome.downloads.search({ id: it.downloadId });
      if (d) applyDownloadState(it, d);
    }
    changed();
    pump();
  }, 600);
}

// ---- Referer rules (declarativeNetRequest session rules) ------------------

const REFERER_TYPES = ['main_frame', 'sub_frame', 'image', 'media', 'xmlhttprequest', 'other'];

// Serialised: concurrent updates would otherwise hand out the same rule id.
let ruleLock = Promise.resolve();
function setRefererRules(tabId, pairs) {
  ruleLock = ruleLock.then(() => applyRefererRules(tabId, pairs)).catch((e) => console.warn('referer rule', e));
  return ruleLock;
}

async function applyRefererRules(tabId, pairs) {
  const existing = await chrome.declarativeNetRequest.getSessionRules();
  let maxId = existing.reduce((m, r) => Math.max(m, r.id), 0);
  const removeRuleIds = [];
  const addRules = [];
  for (const { host, referer } of pairs) {
    if (!host || !referer) continue;
    const old = existing.find((r) => r.condition.tabIds?.[0] === tabId && r.condition.requestDomains?.[0] === host);
    if (old) {
      if (old.action.requestHeaders?.[0]?.value === referer) continue;
      removeRuleIds.push(old.id);
    }
    addRules.push({
      id: old ? old.id : ++maxId,
      priority: 1,
      action: { type: 'modifyHeaders', requestHeaders: [{ header: 'referer', operation: 'set', value: referer }] },
      condition: { tabIds: [tabId], requestDomains: [host], resourceTypes: REFERER_TYPES },
    });
  }
  if (addRules.length) await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds, addRules });
}

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const rules = await chrome.declarativeNetRequest.getSessionRules();
  const ids = rules.filter((r) => r.condition.tabIds?.[0] === tabId).map((r) => r.id);
  if (ids.length) chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: ids });
});
