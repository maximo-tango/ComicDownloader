import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyFilters, DEFAULT_FILTERS, formatBytes, sortItems } from '../extension/lib/filters.js';

const items = [
  { id: 'a', order: 0, width: 1920, height: 1080, bytes: 500_000, format: 'JPEG', isThumbnail: false, confidenceLabel: '높음', originalUrl: 'https://s/img10.jpg' },
  { id: 'b', order: 1, width: 150, height: 150, bytes: 8_000, format: 'PNG', isThumbnail: true, confidenceLabel: '확인 필요', originalUrl: 'https://s/img2.png' },
  { id: 'c', order: 2, width: 800, height: 1200, bytes: null, format: 'WEBP', isThumbnail: false, confidenceLabel: '보통', originalUrl: 'https://s/img1.webp' },
  { id: 'd', order: 3, width: 0, height: 0, bytes: null, format: null, isThumbnail: false, confidenceLabel: '확인 필요', originalUrl: 'https://s/x' },
];
const ids = (r) => r.map((x) => x.id);

test('min width/height', () => {
  assert.deepEqual(ids(applyFilters(items, { ...DEFAULT_FILTERS, minWidth: 700 }).items), ['a', 'c']);
  assert.deepEqual(ids(applyFilters(items, { ...DEFAULT_FILTERS, minHeight: 1100 }).items), ['c']);
});

test('min file size: unknown sizes are included or excluded explicitly', () => {
  assert.deepEqual(ids(applyFilters(items, { ...DEFAULT_FILTERS, minBytes: 100_000 }).items), ['a', 'c', 'd']);
  const r = applyFilters(items, { ...DEFAULT_FILTERS, minBytes: 100_000, includeUnknownSize: false });
  assert.deepEqual(ids(r.items), ['a']);
  assert.equal(r.hiddenUnknownSize, 2);
});

test('format, thumbnail and unsure filters', () => {
  assert.deepEqual(ids(applyFilters(items, { ...DEFAULT_FILTERS, formats: ['PNG', 'OTHER'] }).items), ['b', 'd']);
  assert.deepEqual(ids(applyFilters(items, { ...DEFAULT_FILTERS, excludeThumbnails: true }).items), ['a', 'c', 'd']);
  assert.deepEqual(ids(applyFilters(items, { ...DEFAULT_FILTERS, onlyUnsure: true }).items), ['b', 'd']);
});

test('sorting', () => {
  assert.deepEqual(ids(sortItems(items, 'order')), ['a', 'b', 'c', 'd']);
  assert.deepEqual(ids(sortItems(items, 'width', 'desc')), ['a', 'c', 'b', 'd']);
  assert.deepEqual(ids(sortItems(items, 'bytes', 'desc')), ['a', 'b', 'c', 'd']);
  assert.deepEqual(ids(sortItems(items, 'ratio')), ['d', 'c', 'b', 'a']);
  assert.deepEqual(ids(sortItems(items, 'urlNumber')), ['d', 'c', 'b', 'a']);
  assert.deepEqual(ids(sortItems(items, 'url')), ['c', 'b', 'a', 'd']);
});

test('formatBytes', () => {
  assert.equal(formatBytes(null), null);
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(2048), '2.0 KB');
  assert.equal(formatBytes(3 * 1024 * 1024), '3.00 MB');
});
