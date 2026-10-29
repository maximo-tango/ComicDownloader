// URL helpers shared by the app page, the service worker and the tests.

export const IMAGE_EXT_RE = /\.(jpe?g|jfif|pjpeg|pjp|png|apng|gif|webp|avif|bmp|svg|ico|tiff?|heic|heif)$/i;

const EXT_FORMAT = {
  jpg: 'JPEG', jpeg: 'JPEG', jfif: 'JPEG', pjpeg: 'JPEG', pjp: 'JPEG',
  png: 'PNG', apng: 'PNG', gif: 'GIF', webp: 'WEBP', avif: 'AVIF', bmp: 'BMP',
  svg: 'SVG', ico: 'ICO', tif: 'TIFF', tiff: 'TIFF', heic: 'HEIC', heif: 'HEIC',
};

export function toAbsoluteUrl(raw, base) {
  if (!raw) return null;
  const s = String(raw).trim();
  if (!s || /^(blob|javascript|about):/i.test(s)) return null;
  try {
    const u = new URL(s, base);
    if (!/^(https?|data):$/.test(u.protocol)) return null;
    return u.href;
  } catch {
    return null;
  }
}

export function isHttpUrl(s) {
  try {
    const u = new URL(s);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/** Key used for de-duplication: the URL without its #fragment. */
export function urlKey(url) {
  if (!url) return '';
  if (url.startsWith('data:')) return url;
  const i = url.indexOf('#');
  return i === -1 ? url : url.slice(0, i);
}

export function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

/** Last path segment, percent-decoded, without the query string. */
export function urlBasename(url) {
  if (!url || url.startsWith('data:')) return '';
  try {
    const seg = new URL(url).pathname.split('/').filter(Boolean).pop() || '';
    try {
      return decodeURIComponent(seg);
    } catch {
      return seg;
    }
  } catch {
    return '';
  }
}

export function formatFromUrl(url) {
  if (!url) return null;
  if (url.startsWith('data:')) {
    const m = /^data:image\/([a-z0-9.+-]+)/i.exec(url);
    return m ? formatFromMime('image/' + m[1]) : null;
  }
  const m = IMAGE_EXT_RE.exec(urlBasename(url));
  if (m) return EXT_FORMAT[m[1].toLowerCase()];
  // Formats passed as query parameters, e.g. ?format=webp or &fm=jpg
  try {
    const p = new URL(url).searchParams;
    const f = (p.get('format') || p.get('fm') || p.get('ext') || '').toLowerCase();
    if (EXT_FORMAT[f]) return EXT_FORMAT[f];
  } catch { /* ignore */ }
  return null;
}

export function formatFromMime(mime) {
  if (!mime) return null;
  const m = mime.split(';')[0].trim().toLowerCase();
  const map = {
    'image/jpeg': 'JPEG', 'image/jpg': 'JPEG', 'image/pjpeg': 'JPEG', 'image/png': 'PNG',
    'image/apng': 'PNG', 'image/gif': 'GIF', 'image/webp': 'WEBP', 'image/avif': 'AVIF',
    'image/bmp': 'BMP', 'image/x-ms-bmp': 'BMP', 'image/svg+xml': 'SVG', 'image/x-icon': 'ICO',
    'image/vnd.microsoft.icon': 'ICO', 'image/tiff': 'TIFF', 'image/heic': 'HEIC', 'image/heif': 'HEIC',
  };
  return map[m] || null;
}

/**
 * Classifies a raw URL string from a page. Never throws: bad input becomes
 * { kind: 'invalid' } so one broken attribute can't stop a whole scan.
 *   http   – downloadable http(s) URL
 *   data   – inline data: image (downloadable, kept separate from normal URLs)
 *   blob   – page-scoped blob: URL (tied to the page's lifetime; not downloadable from the extension)
 *   unsafe – javascript:, vbscript:, … never used
 *   invalid / unsupported – cannot be parsed / other schemes (ftp:, chrome:, file: …)
 */
export function classifyUrl(raw, base) {
  const s = String(raw ?? '').trim();
  if (!s) return { kind: 'invalid', url: '', error: '빈 URL' };
  if (/^\s*(javascript|vbscript):/i.test(s)) return { kind: 'unsafe', url: s, error: '실행 가능한 URL은 허용하지 않음' };
  let u;
  try {
    u = new URL(s, base);
  } catch {
    return { kind: 'invalid', url: s, error: '잘못된 URL 형식' };
  }
  if (u.protocol === 'http:' || u.protocol === 'https:') return { kind: 'http', url: u.href };
  if (u.protocol === 'data:') {
    return /^data:image\//i.test(u.href)
      ? { kind: 'data', url: u.href }
      : { kind: 'unsupported', url: u.href.slice(0, 60), error: '이미지가 아닌 data URL' };
  }
  if (u.protocol === 'blob:') return { kind: 'blob', url: u.href, error: 'blob URL은 페이지 안에서만 유효해 다운로드할 수 없음' };
  return { kind: 'unsupported', url: u.href, error: `지원하지 않는 프로토콜 (${u.protocol})` };
}

export function aspectRatioText(w, h) {
  if (!(w > 0 && h > 0)) return null;
  const gcd = (a, b) => (b ? gcd(b, a % b) : a);
  const g = gcd(w, h);
  const [a, b] = [w / g, h / g];
  // Small exact ratios (16:9, 3:2) read better than decimals.
  return a <= 32 && b <= 32 ? `${a}:${b}` : (w / h).toFixed(2);
}
