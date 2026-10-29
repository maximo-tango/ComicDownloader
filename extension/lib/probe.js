// Verifies an image URL: fetches only the first bytes (Range request) to read
// format, pixel size and total file size. Falls back to decoding the image
// when the header can't be parsed. Results are memoised per URL.

import { parseImageHeader } from './image-header.js';
import { formatFromMime, formatFromUrl } from './url-utils.js';

const HEAD_BYTES = 128 * 1024;

export function createProber({ fetchImpl = globalThis.fetch, decode = null, concurrency = 6, timeout = 20000 } = {}) {
  const cache = new Map();
  const queue = [];
  let active = 0;

  const pump = () => {
    while (active < concurrency && queue.length) {
      const job = queue.shift();
      active++;
      job().finally(() => {
        active--;
        pump();
      });
    }
  };
  const schedule = (fn) =>
    new Promise((resolve) => {
      queue.push(() => fn().then(resolve, (e) => resolve({ ok: false, error: String(e?.message || e) })));
      pump();
    });

  async function run(url, hint) {
    let res = await readHead(url, fetchImpl, timeout);
    if (res.ok && !(res.width > 0) && decode && res.format !== 'TIFF' && res.format !== 'HEIC') {
      const d = await decode(url).catch(() => null);
      if (d) Object.assign(res, { width: d.width, height: d.height });
    }
    if (!res.ok && !res.notImage && decode) {
      // Fetch can be refused where an <img> still loads; size stays unknown.
      const d = await decode(url).catch(() => null);
      if (d) res = { ok: true, width: d.width, height: d.height, format: formatFromUrl(url), bytes: null, viaDecode: true };
    }
    if (res.ok && !(res.width > 0) && hint?.w) Object.assign(res, { width: hint.w, height: hint.h });
    return res;
  }

  function probe(url, hint) {
    if (!cache.has(url)) cache.set(url, schedule(() => run(url, hint)));
    return cache.get(url);
  }
  probe.cache = cache;
  probe.forget = (url) => cache.delete(url);
  return probe;
}

export async function readHead(url, fetchImpl, timeout = 20000) {
  if (url.startsWith('data:')) return readDataUrl(url);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const resp = await fetchImpl(url, {
      headers: { Range: `bytes=0-${HEAD_BYTES - 1}` },
      credentials: 'include',
      signal: ctrl.signal,
    });
    if (!resp.ok) return { ok: false, status: resp.status, error: httpError(resp.status) };
    const mime = resp.headers.get('content-type') || '';
    if (/^(text\/html|application\/(json|xhtml))/i.test(mime)) {
      return { ok: false, notImage: true, isPage: /html/i.test(mime), mime, error: `이미지가 아님 (${mime.split(';')[0]})` };
    }
    const bytes = totalSize(resp);
    const head = await readFirstBytes(resp, HEAD_BYTES, ctrl);
    const parsed = parseImageHeader(head);
    if (!parsed && !/^image\//i.test(mime)) {
      return { ok: false, notImage: true, mime, error: `이미지로 인식할 수 없음 (${mime.split(';')[0] || '형식 없음'})` };
    }
    return {
      ok: true,
      status: resp.status,
      mime,
      bytes,
      finalUrl: resp.url,
      format: parsed?.format || formatFromMime(mime) || formatFromUrl(url),
      formatVerified: !!(parsed?.format || formatFromMime(mime)),
      width: parsed?.width || 0,
      height: parsed?.height || 0,
    };
  } catch (e) {
    return { ok: false, error: e?.name === 'AbortError' ? '시간 초과' : `요청 실패 (${e?.message || e})` };
  } finally {
    clearTimeout(timer);
  }
}

function totalSize(resp) {
  const range = resp.headers.get('content-range');
  if (resp.status === 206 && range) {
    const m = /\/(\d+)\s*$/.exec(range);
    return m ? Number(m[1]) : null;
  }
  // A compressed transfer length is not the file size.
  if (resp.headers.get('content-encoding')) return null;
  const len = resp.headers.get('content-length');
  return len != null && /^\d+$/.test(len) ? Number(len) : null;
}

async function readFirstBytes(resp, limit, ctrl) {
  if (!resp.body?.getReader) return new Uint8Array(await resp.arrayBuffer()).subarray(0, limit);
  const reader = resp.body.getReader();
  const chunks = [];
  let n = 0;
  while (n < limit) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    n += value.length;
  }
  if (n >= limit) {
    reader.cancel().catch(() => {});
    ctrl.abort();
  }
  const out = new Uint8Array(Math.min(n, limit));
  let off = 0;
  for (const c of chunks) {
    const part = c.subarray(0, out.length - off);
    out.set(part, off);
    off += part.length;
    if (off >= out.length) break;
  }
  return out;
}

function readDataUrl(url) {
  const m = /^data:([^,;]*)((?:;[^,;]*)*),(.*)$/s.exec(url);
  if (!m) return { ok: false, error: '잘못된 data URL' };
  let bytes;
  try {
    bytes = /;base64/i.test(m[2])
      ? Uint8Array.from(atob(m[3]), (c) => c.charCodeAt(0))
      : new TextEncoder().encode(decodeURIComponent(m[3]));
  } catch {
    return { ok: false, error: '잘못된 data URL' };
  }
  const parsed = parseImageHeader(bytes);
  return {
    ok: !!parsed || /^image\//i.test(m[1]),
    mime: m[1],
    bytes: bytes.length,
    format: parsed?.format || formatFromMime(m[1]),
    formatVerified: !!(parsed?.format || formatFromMime(m[1])),
    width: parsed?.width || 0,
    height: parsed?.height || 0,
  };
}

export function httpError(status) {
  const known = { 401: '인증 필요 (401)', 403: '접근 거부 (403)', 404: '찾을 수 없음 (404)', 410: '삭제됨 (410)', 429: '요청 과다 (429)' };
  return known[status] || (status >= 500 ? `서버 오류 (${status})` : `HTTP ${status}`);
}

/** Downloads the whole body just to count bytes (for servers that send no length). */
export async function measureFullSize(url, fetchImpl = globalThis.fetch) {
  const resp = await fetchImpl(url, { credentials: 'include' });
  if (!resp.ok) throw new Error(httpError(resp.status));
  if (!resp.body?.getReader) return (await resp.arrayBuffer()).byteLength;
  const reader = resp.body.getReader();
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return n;
    n += value.length;
  }
}

/** Browser-only fallback that decodes the image to learn its natural size. */
export function decodeWithImage(url, timeout = 20000) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const timer = setTimeout(() => {
      img.src = '';
      reject(new Error('시간 초과'));
    }, timeout);
    img.onload = () => {
      clearTimeout(timer);
      img.naturalWidth ? resolve({ width: img.naturalWidth, height: img.naturalHeight }) : reject(new Error('크기 없음'));
    };
    img.onerror = () => {
      clearTimeout(timer);
      reject(new Error('로딩 실패'));
    };
    img.referrerPolicy = 'no-referrer-when-downgrade';
    img.src = url;
  });
}
