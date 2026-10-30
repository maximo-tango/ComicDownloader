// Display filters. Filters only decide what is shown: they never delete items,
// never reorder them (the page order is kept) and never touch selection.

export const ALL_FORMATS = ['JPEG', 'PNG', 'WEBP', 'GIF', 'SVG', 'AVIF', 'BMP', 'ICO', 'TIFF', 'HEIC', 'OTHER'];
export const ALL_STATES = ['confirmed', 'hires', 'compare', 'unknown'];

export const LIMITS = { px: 100000, bytes: 10 * 1024 ** 3 };

export const DEFAULT_FILTERS = {
  minWidth: 0,
  minHeight: 0,
  minBytes: 0,
  unknownSize: 'include', // 'include' | 'exclude' items whose size could not be verified
  formats: null, // null = all
  states: null, // null = all original states
  excludeThumbnails: false,
};

export function formatKey(format) {
  return format && ALL_FORMATS.includes(format) ? format : 'OTHER';
}

/**
 * Parses a numeric filter field. Empty means "no limit"; negative, non-numeric
 * or absurdly large input is rejected with a message instead of breaking the list.
 */
export function parseLimit(raw, max) {
  const s = String(raw ?? '').trim();
  if (!s) return { value: 0, error: null };
  const n = Number(s);
  if (!Number.isFinite(n)) return { value: 0, error: '숫자를 입력하세요' };
  if (n < 0) return { value: 0, error: '0 이상이어야 합니다' };
  if (n > max) return { value: max, error: `최대 ${max.toLocaleString()}까지 입력할 수 있습니다` };
  return { value: n, error: null };
}

/** Order-preserving filter. @returns {{ items, hiddenUnknownSize }} */
export function applyFilters(items, f = DEFAULT_FILTERS) {
  let hiddenUnknownSize = 0;
  const out = items.filter((it) => {
    if (f.minWidth && !(it.width >= f.minWidth)) return false;
    if (f.minHeight && !(it.height >= f.minHeight)) return false;
    if (f.minBytes) {
      if (it.bytes == null) {
        if (f.unknownSize === 'exclude') {
          hiddenUnknownSize++;
          return false;
        }
      } else if (it.bytes < f.minBytes) return false;
    }
    if (f.formats && !f.formats.includes(formatKey(it.format))) return false;
    if (f.states && !f.states.includes(it.originalState || 'unknown')) return false;
    if (f.excludeThumbnails && it.isThumbnail) return false;
    return true;
  });
  return { items: out, hiddenUnknownSize };
}

export function formatBytes(n) {
  if (n == null) return null;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

/**
 * Looser versions of `filters` to try, in order, when a page has images but none
 * match (연속 PDF): keep thumbnails, then also accept WEBP, then both. Size limits stay.
 * @returns [{ filters, note }]
 */
export function relaxations(filters) {
  const thumbs = filters.excludeThumbnails ? { excludeThumbnails: false } : null;
  const webp = filters.formats && !filters.formats.includes('WEBP') ? { formats: [...filters.formats, 'WEBP'] } : null;
  const steps = [];
  if (thumbs) steps.push({ filters: { ...filters, ...thumbs }, note: '썸네일 의심 포함' });
  if (webp) steps.push({ filters: { ...filters, ...webp }, note: 'WEBP 포함' });
  if (thumbs && webp) steps.push({ filters: { ...filters, ...thumbs, ...webp }, note: '썸네일 의심 포함 · WEBP 포함' });
  return steps;
}
