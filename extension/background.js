// Service worker: the download queue.
//
// Job states: pending → downloading → success | failed | cancelled
// (failed/cancelled → pending again on retry). Jobs are persisted in
// chrome.storage.session so a restarted worker resumes tracking them, and every
// Chrome download event is checked against the job's *current* download id so
// a late event from an earlier attempt can't overwrite the state.
//
// Images that a site refuses (403, hot-link protection, login) are reported as
// failed with the reason; the extension does not try to get around that.

import { NameRegistry, decideFilename } from './lib/filename.js';
import { formatFromUrl, urlBasename } from './lib/url-utils.js';

const S = { PENDING: 'pending', DOWNLOADING: 'downloading', SUCCESS: 'success', FAILED: 'failed', CANCELLED: 'cancelled' };
const TERMINAL = new Set([S.SUCCESS, S.FAILED, S.CANCELLED]);

const INTERRUPT_REASONS = {
  FILE_FAILED: '파일 저장 실패', FILE_ACCESS_DENIED: '저장 위치 접근 거부', FILE_NO_SPACE: '디스크 공간 부족',
  FILE_NAME_TOO_LONG: '파일명이 너무 김', FILE_TOO_LARGE: '파일이 너무 큼', FILE_VIRUS_INFECTED: '바이러스 검사에서 차단됨',
  FILE_TRANSIENT_ERROR: '일시적인 파일 오류', FILE_BLOCKED: '보안 정책으로 차단됨', FILE_SECURITY_CHECK_FAILED: '보안 검사 실패',
  FILE_TOO_SHORT: '파일이 불완전함', FILE_HASH_MISMATCH: '파일 해시 불일치', FILE_SAME_AS_SOURCE: '원본과 같은 파일',
  NETWORK_FAILED: '네트워크 오류', NETWORK_TIMEOUT: '네트워크 시간 초과', NETWORK_DISCONNECTED: '인터넷 연결 끊김',
  NETWORK_SERVER_DOWN: '서버 응답 없음', NETWORK_INVALID_REQUEST: '잘못된 요청', SERVER_FAILED: '서버 오류',
  SERVER_NO_RANGE: '서버가 이어받기를 지원하지 않음', SERVER_BAD_CONTENT: '서버가 파일을 제공하지 않음 (404 등)',
  SERVER_UNAUTHORIZED: '인증 필요 (401) — 로그인이 필요한 이미지', SERVER_CERT_PROBLEM: '인증서 문제',
  SERVER_FORBIDDEN: '접근 거부 (403) — 사이트가 외부 다운로드를 막았을 수 있음',
  SERVER_UNREACHABLE: '서버에 연결할 수 없음', SERVER_CONTENT_LENGTH_MISMATCH: '전송 크기 불일치',
  SERVER_CROSS_ORIGIN_REDIRECT: '다른 사이트로 리디렉션됨', USER_SHUTDOWN: '브라우저 종료로 중단', CRASH: '브라우저 오류로 중단',
};

let jobs = [];
let nextId = 1;
let seenRequests = {}; // requestId -> job ids, so a retried enqueue never duplicates jobs
let registry = new NameRegistry();
let settings = { conflictAction: 'uniquify', concurrency: 3 };
const byDownloadId = new Map();
const ports = new Set();

const ready = (async () => {
  const { dlState: s } = await chrome.storage.session.get('dlState');
  if (s) {
    jobs = s.jobs || [];
    nextId = s.nextId || 1;
    seenRequests = s.seenRequests || {};
    registry = new NameRegistry(s.registry);
    settings = s.settings || settings;
    await recover();
  }
  pump();
})();

/** After a worker restart: re-attach to Chrome downloads and settle unknown states. */
async function recover() {
  for (const j of jobs) {
    if (j.status !== S.DOWNLOADING) continue;
    if (j.downloadId == null) {
      // The worker stopped between asking Chrome and getting the id: look the download up.
      const found = (await chrome.downloads.search({ url: j.url, startedAfter: new Date(j.startedAt - 1000).toISOString() }))[0];
      if (found) j.downloadId = found.id;
      else {
        j.status = S.PENDING; // nothing was created: safe to start again
        continue;
      }
    }
    byDownloadId.set(j.downloadId, j);
    const [d] = await chrome.downloads.search({ id: j.downloadId });
    if (d) applyDownloadState(j, d);
    else fail(j, '확장 프로그램이 재시작되는 동안 다운로드 기록이 사라짐 — 재시도하세요');
  }
  changed();
}

// ---- persistence & broadcast ---------------------------------------------

const stateToSave = () => ({ jobs, nextId, registry: registry.toJSON(), settings, seenRequests });

/** Saves right away: used before anything a restarted worker must know about. */
function persistNow() {
  return chrome.storage.session.set({ dlState: stateToSave() });
}

let saveTimer = null;
let broadcastTimer = null;
function changed() {
  if (!saveTimer) {
    saveTimer = setTimeout(() => {
      saveTimer = null;
      persistNow();
    }, 250);
  }
  if (!broadcastTimer) {
    broadcastTimer = setTimeout(() => {
      broadcastTimer = null;
      for (const p of ports) p.postMessage({ type: 'downloads', jobs });
    }, 150);
  }
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'ih-downloads') return;
  ports.add(port);
  ready.then(() => port.postMessage({ type: 'downloads', jobs }));
  port.onDisconnect.addListener(() => ports.delete(port));
});

// ---- commands from extension pages ----------------------------------------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return false;
  ready
    .then(() => handle(msg))
    .then((r) => sendResponse({ ok: true, ...r }), (e) => sendResponse({ ok: false, error: String(e?.message || e) }));
  return true;
});

async function handle(msg) {
  switch (msg.type) {
    case 'enqueue': {
      if (msg.requestId && seenRequests[msg.requestId]) return { ids: seenRequests[msg.requestId] };
      if (msg.settings) settings = { ...settings, ...msg.settings };
      const bad = msg.jobs.find((x) => !/^(https?:|data:image\/)/i.test(x.url));
      if (bad) throw new Error(`다운로드할 수 없는 URL: ${String(bad.url).slice(0, 80)}`);
      const ids = msg.jobs.map((x) => {
        const j = {
          id: nextId++,
          url: x.url,
          sourceUrl: x.sourceUrl || x.url,
          source: x.source === 'paste' ? 'paste' : 'page',
          sourceTabId: x.sourceTabId ?? null,
          itemKey: x.itemKey || null,
          folder: x.folder,
          customName: x.customName || '',
          fallbackBase: x.fallbackBase || '',
          format: x.format || null,
          formatVerified: !!x.formatVerified,
          mime: x.mime || null,
          serverName: x.serverName || '',
          width: x.width || 0,
          height: x.height || 0,
          status: S.PENDING,
          bytesReceived: 0,
          totalBytes: x.bytes || 0,
          filename: '',
          extensionGuessed: false,
          error: null,
          attempts: 0,
          createdAt: Date.now(),
          startedAt: null,
          finishedAt: null,
          downloadId: null,
        };
        jobs.push(j);
        return j.id;
      });
      if (msg.requestId) {
        seenRequests[msg.requestId] = ids;
        const keys = Object.keys(seenRequests);
        if (keys.length > 100) delete seenRequests[keys[0]];
      }
      await persistNow();
      changed();
      pump();
      return { ids };
    }
    case 'retry': {
      // Only failed/cancelled jobs: successful files are never downloaded again.
      const ids = msg.ids ? new Set(msg.ids) : null;
      for (const j of jobs) {
        if (ids ? !ids.has(j.id) : j.status !== S.FAILED) continue;
        if (j.status !== S.FAILED && j.status !== S.CANCELLED) continue;
        if (j.filename) registry.release(j.folder, j.filename.split('/').pop());
        if (j.downloadId != null) byDownloadId.delete(j.downloadId);
        Object.assign(j, { status: S.PENDING, error: null, bytesReceived: 0, downloadId: null, filename: '', finishedAt: null });
      }
      changed();
      pump();
      return {};
    }
    case 'cancel': {
      const ids = msg.ids ? new Set(msg.ids) : null;
      for (const j of jobs) {
        if (ids && !ids.has(j.id)) continue;
        if (j.status === S.PENDING) setTerminal(j, S.CANCELLED);
        else if (j.status === S.DOWNLOADING) {
          setTerminal(j, S.CANCELLED);
          if (j.downloadId != null) await chrome.downloads.cancel(j.downloadId).catch(() => {});
        }
      }
      changed();
      pump();
      return {};
    }
    case 'clear': {
      const statuses = new Set(msg.statuses || [S.SUCCESS, S.CANCELLED]);
      jobs = jobs.filter((j) => !statuses.has(j.status));
      changed();
      return {};
    }
    case 'snapshot':
      return { jobs };
    default:
      throw new Error(`unknown command ${msg.type}`);
  }
}

// ---- queue ---------------------------------------------------------------

function pump() {
  const busy = jobs.filter((j) => j.status === S.DOWNLOADING).length;
  let free = Math.max(1, Math.min(8, Number(settings.concurrency) || 3)) - busy;
  for (const j of jobs) {
    if (free <= 0) break;
    if (j.status !== S.PENDING) continue;
    free--;
    start(j);
  }
  ensurePolling();
}

// The file name is decided here, before the download starts. (An
// onDeterminingFilename listener would make Chrome wait on this worker for
// every download in the browser, including the user's own.)
function nameFor(j) {
  const { name, extensionGuessed } = decideFilename({
    customName: j.customName,
    serverName: j.serverName || urlBasename(j.url),
    mime: /^image\//i.test(j.mime || '') ? j.mime : null,
    format: j.formatVerified ? j.format : null,
    urlFormat: j.format || formatFromUrl(j.url),
    fallbackBase: j.fallbackBase,
    folder: j.folder,
    registry,
  });
  j.filename = `${j.folder}/${name}`;
  j.extensionGuessed = extensionGuessed;
}

async function start(j) {
  Object.assign(j, { status: S.DOWNLOADING, startedAt: Date.now(), attempts: j.attempts + 1, downloadId: null });
  if (!j.filename) nameFor(j);
  changed();
  try {
    // A worker restarted after this point finds the job as "downloading" and
    // looks the Chrome download up by URL instead of starting it twice.
    await persistNow();
    const downloadId = await chrome.downloads.download({ url: j.url, filename: j.filename, conflictAction: settings.conflictAction, saveAs: false });
    if (j.status === S.CANCELLED) {
      chrome.downloads.cancel(downloadId).catch(() => {});
      return;
    }
    j.downloadId = downloadId;
    byDownloadId.set(downloadId, j);
    // The download may have finished before we got its id.
    const [d] = await chrome.downloads.search({ id: downloadId });
    if (d) applyDownloadState(j, d);
  } catch (e) {
    fail(j, `다운로드를 시작할 수 없음: ${e?.message || e}`);
  }
  changed();
  pump();
}

chrome.downloads.onChanged.addListener(async (delta) => {
  await ready;
  const j = byDownloadId.get(delta.id);
  if (!j) return;
  const [d] = await chrome.downloads.search({ id: delta.id });
  if (d) applyDownloadState(j, d);
  changed();
  pump();
});

function setTerminal(j, status, error = null) {
  j.status = status;
  j.error = error;
  j.finishedAt = Date.now();
}

function fail(j, error) {
  setTerminal(j, S.FAILED, error);
}

function applyDownloadState(j, d) {
  // Ignore events from an earlier attempt of this job.
  if (j.downloadId !== d.id) return;
  if (j.status === S.CANCELLED && d.state !== 'complete') return;
  j.bytesReceived = d.bytesReceived;
  if (d.totalBytes > 0) j.totalBytes = d.totalBytes;
  if (d.filename) j.savedPath = d.filename;
  if (d.state === 'complete') {
    if (j.status !== S.SUCCESS) setTerminal(j, S.SUCCESS);
    j.bytesReceived = j.totalBytes = d.fileSize || d.bytesReceived;
  } else if (d.state === 'interrupted') {
    if (TERMINAL.has(j.status)) return;
    if (d.error === 'USER_CANCELED') setTerminal(j, S.CANCELLED);
    else fail(j, INTERRUPT_REASONS[d.error] || d.error || '알 수 없는 오류');
  }
}

// onChanged does not report byte progress, so running downloads are polled.
let pollTimer = null;
function ensurePolling() {
  const running = () => jobs.filter((j) => j.status === S.DOWNLOADING && j.downloadId != null);
  if (pollTimer || !running().length) return;
  pollTimer = setInterval(async () => {
    const list = running();
    if (!list.length) {
      clearInterval(pollTimer);
      pollTimer = null;
      return;
    }
    for (const j of list) {
      const [d] = await chrome.downloads.search({ id: j.downloadId });
      if (d) applyDownloadState(j, d);
    }
    changed();
    pump();
  }, 600);
}
