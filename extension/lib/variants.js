// Generates "maybe larger" variants of an image URL by undoing common
// thumbnail conventions. These are only guesses: the resolver must verify
// each one by actually reading the image before trusting it.

const THUMB_WORDS = 'thumb|thumbs|thumbnail|thumbnails|small|medium|mini|preview|tn|sm|md|lowres|low|resized|resize|cache|crop|cropped|square';
const THUMB_SEGMENT_RE = new RegExp(`^(${THUMB_WORDS}|_thumbs?|t|s|\\d{2,4}x\\d{2,4}|w\\d{2,4}|h\\d{2,4}|\\d{2,4}px)$`, 'i');
const THUMB_SUFFIX_RE = new RegExp(`[-_.](${THUMB_WORDS}|\\d{2,4}x\\d{2,4}|\\d{2,4}w|\\d{2,4}px)(?=\\.[a-z0-9]{2,5}$)`, 'i');
// Narrower word list for flagging: words like "low" or "md" are too common in real names.
const THUMB_MARKER_RE = /(^|[/_.\-=])(thumb|thumbs|thumbnail|thumbnails|small|mini|preview|tn)([/_.\-=]|\d|$)|[-_]\d{2,3}x\d{2,3}\.[a-z0-9]{2,5}$/i;
const SIZE_PARAMS = ['w', 'h', 'width', 'height', 'size', 'resize', 'fit', 'crop', 'dpr', 'q', 'quality', 'maxwidth', 'maxheight', 'mw', 'mh', 'thumb', 'thumbnail', 's'];
const SIZE_NAME_VALUES = /^(thumb|thumbnail|small|medium|tiny|preview|\d{2,4}x\d{2,4})$/i;

/** Heuristic: does the URL itself look like a thumbnail? */
export function hasThumbMarker(url) {
  if (!url || url.startsWith('data:')) return false;
  try {
    const u = new URL(url);
    if (THUMB_MARKER_RE.test(u.pathname)) return true;
    for (const [k, v] of u.searchParams) {
      if (/^(thumb|thumbnail)$/i.test(k)) return true;
      if (/^(name|size|type)$/i.test(k) && SIZE_NAME_VALUES.test(v)) return true;
    }
  } catch { /* ignore */ }
  return false;
}

/**
 * @returns {{url: string, rule: string}[]} distinct variants, most plausible first.
 */
export function generateVariants(url, max = 6) {
  if (!url || url.startsWith('data:')) return [];
  let u;
  try {
    u = new URL(url);
  } catch {
    return [];
  }
  const out = [];
  const seen = new Set([u.href]);
  const push = (href, rule) => {
    if (!seen.has(href) && out.length < max) {
      seen.add(href);
      out.push({ url: href, rule });
    }
  };
  const withPath = (path) => {
    const c = new URL(u.href);
    c.pathname = path;
    return c;
  };

  // WordPress-style "photo-300x200.jpg" and "photo_thumb.jpg"
  const segs = u.pathname.split('/');
  const last = segs[segs.length - 1];
  if (THUMB_SUFFIX_RE.test(last)) {
    const stripped = last.replace(THUMB_SUFFIX_RE, '');
    push(withPath([...segs.slice(0, -1), stripped].join('/')).href, 'suffix');
  }
  // "-scaled" is WordPress's downscaled original
  if (/-scaled(?=\.[a-z0-9]{2,5}$)/i.test(last)) {
    push(withPath([...segs.slice(0, -1), last.replace(/-scaled(?=\.[a-z0-9]{2,5}$)/i, '')].join('/')).href, 'suffix');
  }

  // Thumbnail directory segments: /thumbs/a.jpg -> /a.jpg, /original/a.jpg, /large/a.jpg
  for (let i = 1; i < segs.length - 1; i++) {
    if (THUMB_SEGMENT_RE.test(segs[i])) {
      const without = [...segs.slice(0, i), ...segs.slice(i + 1)].join('/');
      push(withPath(without).href, 'path');
      for (const repl of ['original', 'large', 'full']) {
        push(withPath([...segs.slice(0, i), repl, ...segs.slice(i + 1)].join('/')).href, 'path');
      }
      break;
    }
  }

  // Image-CDN transformation segments, e.g. /upload/w_300,h_200,c_fill/ (Cloudinary-like)
  const tIdx = segs.findIndex((s, i) => i < segs.length - 1 && /^([a-z]{1,2}_[a-z0-9.:]+)(,[a-z]{1,2}_[a-z0-9.:]+)*$/i.test(s));
  if (tIdx > 0) push(withPath([...segs.slice(0, tIdx), ...segs.slice(tIdx + 1)].join('/')).href, 'cdn-transform');

  // Google-style "=s200" / "=w300-h200" suffixes
  if (/=([swh]\d+[^/]*)$/.test(u.pathname)) {
    push(withPath(u.pathname.replace(/=([swh]\d+[^/]*)$/, '=s0')).href, 'size-suffix');
  }

  // Query parameters: ?name=small -> name=orig, and dropping resize params
  if (u.search) {
    const name = u.searchParams.get('name');
    if (name && SIZE_NAME_VALUES.test(name)) {
      for (const v of ['orig', 'large']) {
        const c = new URL(u.href);
        c.searchParams.set('name', v);
        push(c.href, 'query-name');
      }
    }
    const c = new URL(u.href);
    let removed = false;
    for (const k of [...c.searchParams.keys()]) {
      if (SIZE_PARAMS.includes(k.toLowerCase())) {
        c.searchParams.delete(k);
        removed = true;
      }
    }
    if (removed) push(c.href, 'query-size');
  }
  return out;
}
