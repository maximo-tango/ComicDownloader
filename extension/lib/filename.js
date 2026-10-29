// File and folder naming policy for downloads.
//  - A usable server/URL-provided name wins.
//  - Otherwise the name is built from the page title and the image's position
//    ("페이지 제목_012.jpg"), or image_001, image_002 … when there is no title.
//  - Name clashes get "name (1).jpg", "name (2).jpg" — the same style Chrome uses
//    on disk, where existing files are never overwritten by default.

const MIME_EXT = {
  'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/pjpeg': 'jpg', 'image/png': 'png', 'image/apng': 'png',
  'image/gif': 'gif', 'image/webp': 'webp', 'image/avif': 'avif', 'image/svg+xml': 'svg', 'image/bmp': 'bmp',
  'image/x-ms-bmp': 'bmp', 'image/x-icon': 'ico', 'image/vnd.microsoft.icon': 'ico', 'image/tiff': 'tif',
  'image/heic': 'heic', 'image/heif': 'heif',
};
const FORMAT_EXT = { JPEG: 'jpg', PNG: 'png', GIF: 'gif', WEBP: 'webp', AVIF: 'avif', SVG: 'svg', BMP: 'bmp', ICO: 'ico', TIFF: 'tif', HEIC: 'heic' };
const IMAGE_EXTS = new Set(['jpg', 'jpeg', 'jfif', 'png', 'apng', 'gif', 'webp', 'avif', 'svg', 'bmp', 'ico', 'tif', 'tiff', 'heic', 'heif']);
const GENERIC_NAMES = new Set(['download', 'downloads', 'image', 'img', 'file', 'index', 'default', 'unnamed', 'untitled', 'blob', 'null', 'undefined', 'view', 'get', 'show', 'fetch', 'photo.php', 'image.php']);
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const MAX_BASE = 100;

export const AUTO_PREFIX = 'image';

export function extForMime(mime) {
  return MIME_EXT[(mime || '').split(';')[0].trim().toLowerCase()] || null;
}
export function extForFormat(format) {
  return FORMAT_EXT[format] || null;
}

/** Splits "name.ext". Only a short alphanumeric tail counts as an extension, so
 *  "116화. 조태청(1)" stays one name instead of losing everything after the dot. */
export function splitExt(name) {
  const m = /^(.+)\.([A-Za-z0-9]{1,5})$/.exec(name);
  return m ? [m[1], m[2]] : [name, ''];
}

/** Makes a single path segment safe on Windows (and everywhere else). */
export function sanitizeSegment(s) {
  let out = String(s ?? '')
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[<>:"/\\|?*]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.\s]+|[.\s]+$/g, '');
  if (WINDOWS_RESERVED.test(out.split('.')[0])) out = '_' + out;
  return out;
}

export function sanitizeFilename(name) {
  const clean = sanitizeSegment(name);
  let [base, ext] = splitExt(clean);
  if (base.length > MAX_BASE) base = base.slice(0, MAX_BASE).trim();
  ext = ext.toLowerCase().slice(0, 5);
  return ext ? `${base}.${ext}` : base;
}

/** Is a server/URL-provided name worth keeping? */
export function isUsableName(name) {
  if (!name) return false;
  const [base, ext] = splitExt(name);
  if (!base || base.length > 150) return false;
  if (/[?&=]/.test(name)) return false; // looks like a query string
  if (/%[0-9a-f]{2}/i.test(name)) return false; // undecoded
  if (GENERIC_NAMES.has(name.toLowerCase()) || GENERIC_NAMES.has(base.toLowerCase())) return false;
  if (ext && !IMAGE_EXTS.has(ext.toLowerCase()) && !/^[a-z0-9]{1,5}$/i.test(ext)) return false;
  return /[\p{L}\p{N}]/u.test(base);
}

/** Picks the extension: keep an image extension; otherwise derive from MIME/format. */
export function withImageExt(name, { mime, format } = {}) {
  let [base, ext] = splitExt(name);
  // "photo.txt" / "view.php": not an image extension, so it is replaced, not kept.
  if (ext && /^(txt|html?|php|aspx?|jsp|cgi|json|xml|bin)$/i.test(ext)) {
    name = base;
    ext = '';
  }
  const known = ext && IMAGE_EXTS.has(ext.toLowerCase());
  const fromType = extForMime(mime) || extForFormat(format);
  if (known) {
    // Fix obviously wrong extensions (e.g. a .jpg that is really WebP).
    if (fromType && !sameFamily(ext, fromType)) return `${base}.${fromType}`;
    return `${base}.${ext.toLowerCase() === 'jpeg' ? 'jpg' : ext.toLowerCase()}`;
  }
  return fromType ? `${name}.${fromType}` : name;
}

function sameFamily(a, b) {
  const norm = (e) => ({ jpeg: 'jpg', jfif: 'jpg', tiff: 'tif', heif: 'heic', apng: 'png' })[e.toLowerCase()] || e.toLowerCase();
  return norm(a) === norm(b);
}

export function siteFolderName(urlOrHost) {
  let host = urlOrHost || '';
  try {
    host = new URL(urlOrHost).hostname;
  } catch { /* already a host */ }
  host = host.replace(/^www\./i, '');
  return sanitizeSegment(host) || 'unknown-site';
}

/**
 * Relative download folder (always under Chrome's download directory).
 * folderMode: 'page' = page title, 'site' = host name, 'none' = root only.
 */
export function buildFolder({ rootFolder = 'ImageHunter', folderMode = 'page', subFolder = '' } = {}, { pageTitle = '', url = '' } = {}) {
  const parts = [sanitizeSegment(rootFolder).slice(0, 60) || 'ImageHunter'];
  if (folderMode === 'page') {
    const t = sanitizeSegment(pageTitle).slice(0, 80).trim();
    parts.push(t || (url ? siteFolderName(url) : ''));
  } else if (folderMode === 'site' && url) {
    parts.push(siteFolderName(url));
  }
  for (const p of String(subFolder || '').split(/[\\/]/)) {
    const s = sanitizeSegment(p).slice(0, 80);
    if (s) parts.push(s);
  }
  return parts.filter(Boolean).join('/');
}

/** "페이지 제목_012" — the fallback base name for the n-th image (1-based). */
export function fallbackBaseName(pageTitle, position) {
  const title = sanitizeSegment(pageTitle).slice(0, 60).trim();
  return title ? `${title}_${pad(position)}` : '';
}

const pad = (n) => String(n).padStart(3, '0');

/** Tracks names handed out per folder so a batch never collides with itself. */
export class NameRegistry {
  constructor(data) {
    this.used = new Map(Object.entries(data?.used || {}).map(([k, v]) => [k, new Set(v)]));
    this.counters = new Map(Object.entries(data?.counters || {}));
  }

  toJSON() {
    return {
      used: Object.fromEntries([...this.used].map(([k, v]) => [k, [...v]])),
      counters: Object.fromEntries(this.counters),
    };
  }

  #set(folder) {
    if (!this.used.has(folder)) this.used.set(folder, new Set());
    return this.used.get(folder);
  }

  has(folder, name) {
    return this.#set(folder).has(name.toLowerCase());
  }

  claim(folder, name) {
    const set = this.#set(folder);
    const [base, ext] = splitExt(name);
    let candidate = name;
    for (let i = 1; set.has(candidate.toLowerCase()); i++) {
      candidate = ext ? `${base} (${i}).${ext}` : `${base} (${i})`;
    }
    set.add(candidate.toLowerCase());
    return candidate;
  }

  release(folder, name) {
    this.#set(folder).delete(name.toLowerCase());
  }

  nextAuto(folder, ext) {
    const set = this.#set(folder);
    let n = Number(this.counters.get(folder) || 0);
    let name;
    do {
      n++;
      name = ext ? `${AUTO_PREFIX}_${pad(n)}.${ext}` : `${AUTO_PREFIX}_${pad(n)}`;
    } while (set.has(name.toLowerCase()));
    this.counters.set(folder, n);
    set.add(name.toLowerCase());
    return name;
  }
}

/**
 * Final file name for one download.
 * @param customName    user-supplied name (wins when non-empty)
 * @param serverName    name Chrome determined from Content-Disposition / URL
 * @param mime          MIME type reported by the server for this download
 * @param format        format verified from the file's bytes (null if unknown)
 * @param urlFormat     format guessed from the URL only
 * @param fallbackBase  base name to use when the server name is unusable
 * @returns {{ name: string, extensionGuessed: boolean }}
 */
export function decideFilename({ customName, serverName, mime, format, urlFormat, folder, registry, fallbackBase }) {
  const verified = extForMime(mime) || extForFormat(format);
  const guessed = extForFormat(urlFormat);
  const typeInfo = verified ? { mime: extForMime(mime) ? mime : null, format } : { format: urlFormat };
  const custom = customName ? sanitizeFilename(customName) : '';
  let candidate = null;
  if (custom && /[\p{L}\p{N}]/u.test(custom)) candidate = custom;
  else {
    const base = serverName ? sanitizeFilename(String(serverName).split(/[\\/]/).pop()) : '';
    if (isUsableName(base)) candidate = base;
  }
  if (!candidate && fallbackBase) candidate = sanitizeFilename(fallbackBase);
  if (candidate) {
    const named = withImageExt(candidate, typeInfo);
    const ext = splitExt(named)[1].toLowerCase();
    return { name: registry.claim(folder, named), extensionGuessed: !verified || !ext };
  }
  const ext = verified || guessed;
  return { name: registry.nextAuto(folder, ext || 'jpg'), extensionGuessed: !verified };
}

/** What the UI shows before downloading (the server may still supply a better name). */
export function previewFilename(url, format) {
  let seg = '';
  try {
    seg = new URL(url).pathname.split('/').filter(Boolean).pop() || '';
    seg = decodeURIComponent(seg);
  } catch { /* ignore */ }
  const clean = sanitizeFilename(seg);
  return isUsableName(clean) ? withImageExt(clean, { format }) : null;
}
