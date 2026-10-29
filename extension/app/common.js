export const $ = (sel, root = document) => root.querySelector(sel);

export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c);
  return el;
}

let toastTimer;
export function toast(msg, ms = 2600) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), ms);
}

const RETRYABLE = new Set(['enqueue', 'retry', 'cancel', 'clear', 'snapshot']);

/**
 * Sends a command to the service worker. Chrome may stop the worker while it
 * handles a request, leaving it unanswered; idempotent commands are then sent
 * once more (enqueue carries a request id so it is never applied twice).
 */
export async function command(type, payload = {}) {
  const msg = { type, ...payload };
  if (type === 'enqueue') msg.requestId = crypto.randomUUID();
  const attempts = RETRYABLE.has(type) ? 2 : 1;
  for (let i = 1; ; i++) {
    const res = await Promise.race([
      chrome.runtime.sendMessage(msg).catch((e) => ({ ok: false, error: e.message, lost: true })),
      new Promise((r) => setTimeout(() => r({ ok: false, error: '확장 프로그램 응답 없음', lost: true }), 8000)),
    ]);
    if (res?.ok) return res;
    if (!res?.lost || i >= attempts) throw new Error(res?.error || '알 수 없는 오류');
  }
}

/** Saves a text file (relative to the download folder) straight from the page. */
export async function saveTextFile(filename, text, { bom = true } = {}) {
  // Chrome renames data: downloads to match their MIME type, so it must fit the extension.
  const ext = (filename.split('.').pop() || '').toLowerCase();
  const mime = { csv: 'text/csv', json: 'application/json' }[ext] || 'text/plain';
  const url = `data:${mime};charset=utf-8,` + encodeURIComponent((bom ? '\ufeff' : '') + text);
  await chrome.downloads.download({ url, filename, saveAs: false, conflictAction: 'uniquify' });
}

export function timestamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export const STATUS_LABEL = { pending: '대기', downloading: '진행 중', success: '완료', failed: '실패', cancelled: '취소' };

export function rafThrottle(fn) {
  let scheduled = false;
  return () => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      fn();
    });
  };
}
