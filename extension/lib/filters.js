// Filtering and sorting of resolved items. Pure functions so the list view,
// the sequential viewer and the tests all agree on the same order.

import { naturalCompare, urlNumbers } from './url-utils.js';

export const ALL_FORMATS = ['JPEG', 'PNG', 'WEBP', 'GIF', 'SVG', 'AVIF', 'BMP', 'ICO', 'TIFF', 'HEIC', 'OTHER'];

export const DEFAULT_FILTERS = {
  minWidth: 0,
  minHeight: 0,
  minBytes: 0,
  includeUnknownSize: true,
  formats: null, // null = all
  excludeThumbnails: false,
  onlyUnsure: false,
};

export function formatKey(format) {
  return format && ALL_FORMATS.includes(format) ? format : 'OTHER';
}

/** @returns {{ items: object[], hiddenUnknownSize: number }} */
export function applyFilters(items, f = DEFAULT_FILTERS) {
  let hiddenUnknownSize = 0;
  const out = items.filter((it) => {
    if (f.minWidth && !(it.width >= f.minWidth)) return false;
    if (f.minHeight && !(it.height >= f.minHeight)) return false;
    if (f.minBytes) {
      if (it.bytes == null) {
        if (!f.includeUnknownSize) {
          hiddenUnknownSize++;
          return false;
        }
      } else if (it.bytes < f.minBytes) return false;
    }
    if (f.formats && !f.formats.includes(formatKey(it.format))) return false;
    if (f.excludeThumbnails && it.isThumbnail) return false;
    if (f.onlyUnsure && it.confidenceLabel !== '확인 필요') return false;
    return true;
  });
  return { items: out, hiddenUnknownSize };
}

const area = (it) => (it.width || 0) * (it.height || 0);
const ratio = (it) => (it.width && it.height ? it.width / it.height : 0);

function compareNumbers(a, b) {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i] ?? -1;
    const y = b[i] ?? -1;
    if (x !== y) return x - y;
  }
  return 0;
}

const COMPARATORS = {
  order: (a, b) => a.order - b.order,
  width: (a, b) => (a.width || 0) - (b.width || 0),
  height: (a, b) => (a.height || 0) - (b.height || 0),
  area: (a, b) => area(a) - area(b),
  ratio: (a, b) => ratio(a) - ratio(b),
  bytes: (a, b) => (a.bytes ?? -1) - (b.bytes ?? -1),
  format: (a, b) => naturalCompare(a.format || '~', b.format || '~'),
  url: (a, b) => naturalCompare(a.originalUrl, b.originalUrl),
  urlNumber: (a, b) => compareNumbers(urlNumbers(a.originalUrl), urlNumbers(b.originalUrl)),
};

export const SORT_LABELS = {
  order: '발견 순서', width: '너비', height: '높이', area: '해상도(면적)', ratio: '가로세로 비율',
  bytes: '파일 크기', format: '형식', url: 'URL', urlNumber: 'URL 숫자 (보조)',
};

export function sortItems(items, key = 'order', dir = 'asc') {
  const cmp = COMPARATORS[key] || COMPARATORS.order;
  const sign = dir === 'desc' ? -1 : 1;
  // Discovery order is always the tie-breaker, so equal keys stay stable.
  return [...items].sort((a, b) => sign * cmp(a, b) || a.order - b.order);
}

export function formatBytes(n) {
  if (n == null) return null;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}
