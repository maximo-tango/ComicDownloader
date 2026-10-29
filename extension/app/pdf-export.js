// Builds one PDF from a list of image URLs, one image per page, in list order.
// JPEGs are embedded unchanged; other formats are decoded and stored losslessly.
// Images the extension is not allowed to read are skipped and reported.

import { command } from './common.js';
import { buildPdf } from '../lib/pdf.js';
import { jpegDetails } from '../lib/image-header.js';
import { fetchWithFallback } from '../lib/probe.js';

/**
 * @param sources      [{ url, label }] in the order the pages should appear
 * @param readViaPage  optional async (url) => { ok, dataUrl, error } using the source page
 * @returns {{ blob, included: number, skipped: { url, label, reason }[] }}
 */
export async function createPdf(sources, { title = '', pageSize = 'image', readViaPage = null, onProgress = () => {}, signal } = {}) {
  const pages = [];
  const skipped = [];
  for (let i = 0; i < sources.length; i++) {
    if (signal?.aborted) throw new DOMException('취소됨', 'AbortError');
    const src = sources[i];
    onProgress(i, sources.length, src);
    try {
      const bytes = await readBytes(src.url, readViaPage);
      pages.push(await toPage(bytes));
    } catch (e) {
      skipped.push({ url: src.url, label: src.label, reason: e?.message || String(e), needsPermission: !!e?.needsPermission });
    }
  }
  onProgress(sources.length, sources.length, null);
  if (!pages.length) return { blob: null, included: 0, skipped };
  const blob = new Blob(buildPdf(pages, { pageSize, title }), { type: 'application/pdf' });
  return { blob, included: pages.length, skipped };
}

async function readBytes(url, readViaPage) {
  if (url.startsWith('data:')) return dataUrlBytes(url);
  let reason;
  try {
    const resp = await fetchWithFallback(fetch, url, {});
    if (resp.ok) return new Uint8Array(await resp.arrayBuffer());
    reason = `서버 응답 ${resp.status}`;
    if (resp.status === 401 || resp.status === 403) throw new Error(`접근 거부 (${resp.status})`);
  } catch (e) {
    if (/접근 거부/.test(e.message)) throw e;
    reason ||= '이미지 데이터를 읽을 권한이 없음 (다른 사이트 이미지 — 설정에서 사이트 접근을 허용하면 넣을 수 있음)';
  }
  if (readViaPage) {
    const r = await readViaPage(url).catch(() => null);
    if (r?.ok) return dataUrlBytes(r.dataUrl);
  }
  const err = new Error(reason);
  // The request itself was refused (CORS), not the server: site access would help.
  err.needsPermission = !/^서버 응답/.test(reason);
  throw err;
}

function dataUrlBytes(dataUrl) {
  const i = dataUrl.indexOf(',');
  const meta = dataUrl.slice(0, i);
  const body = dataUrl.slice(i + 1);
  return /;base64/i.test(meta) ? Uint8Array.from(atob(body), (c) => c.charCodeAt(0)) : new TextEncoder().encode(decodeURIComponent(body));
}

async function toPage(bytes) {
  const j = jpegDetails(bytes);
  // Pass-through keeps the original JPEG data untouched. Rotated (EXIF) and
  // CMYK JPEGs go through the decoder so the page looks like the browser shows it.
  if (j && (j.components === 1 || j.components === 3) && j.orientation === 1 && j.width && j.height) {
    return { kind: 'jpeg', data: bytes, width: j.width, height: j.height, components: j.components };
  }
  const blobUrl = URL.createObjectURL(new Blob([bytes]));
  try {
    const img = new Image();
    img.src = blobUrl;
    await img.decode().catch(() => {
      throw new Error('이미지를 해석할 수 없음 (손상되었거나 지원하지 않는 형식)');
    });
    const w = img.naturalWidth;
    const hgt = img.naturalHeight;
    if (!w || !hgt) throw new Error('이미지 크기를 알 수 없음');
    const canvas = new OffscreenCanvas(w, hgt);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff'; // transparent areas become white, as on paper
    ctx.fillRect(0, 0, w, hgt);
    ctx.drawImage(img, 0, 0);
    const rgba = ctx.getImageData(0, 0, w, hgt).data;
    const rgb = new Uint8Array(w * hgt * 3);
    for (let s = 0, d = 0; s < rgba.length; s += 4, d += 3) {
      rgb[d] = rgba[s];
      rgb[d + 1] = rgba[s + 1];
      rgb[d + 2] = rgba[s + 2];
    }
    return { kind: 'flate', data: await deflate(rgb), width: w, height: hgt };
  } finally {
    URL.revokeObjectURL(blobUrl);
  }
}

async function deflate(bytes) {
  // 'deflate' = zlib format, which is what PDF's FlateDecode expects.
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Saves a generated PDF under the given relative path (named by the service worker). */
export async function savePdf(blob, filename) {
  const url = URL.createObjectURL(blob);
  let res;
  try {
    res = await command('saveUrl', { url, filename });
  } catch (e) {
    URL.revokeObjectURL(url);
    throw e;
  }
  // The blob must stay alive until Chrome has written the file.
  const release = () => {
    chrome.downloads.onChanged.removeListener(onChanged);
    URL.revokeObjectURL(url);
  };
  const onChanged = (d) => {
    if (d.id === res.downloadId && d.state && d.state.current !== 'in_progress') release();
  };
  chrome.downloads.onChanged.addListener(onChanged);
  setTimeout(release, 10 * 60 * 1000);
}
