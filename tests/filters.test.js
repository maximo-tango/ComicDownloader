import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyFilters, DEFAULT_FILTERS, formatBytes, parseLimit } from '../extension/lib/filters.js';

const items = [
  { id: 'a', order: 0, width: 1920, height: 1080, bytes: 500_000, format: 'JPEG', isThumbnail: false, originalState: 'confirmed', originalUrl: 'https://s/img10.jpg' },
  { id: 'b', order: 1, width: 150, height: 150, bytes: 8_000, format: 'PNG', isThumbnail: true, originalState: 'unknown', originalUrl: 'https://s/img2.png' },
  { id: 'c', order: 2, width: 800, height: 1200, bytes: null, format: 'WEBP', isThumbnail: false, originalState: 'hires', originalUrl: 'https://s/img1.webp' },
  { id: 'd', order: 3, width: 0, height: 0, bytes: null, format: null, isThumbnail: false, originalState: 'unknown', originalUrl: 'https://s/x' },
];
const ids = (r) => r.map((x) => x.id);

test('min width/height', () => {
  assert.deepEqual(ids(applyFilters(items, { ...DEFAULT_FILTERS, minWidth: 700 }).items), ['a', 'c']);
  assert.deepEqual(ids(applyFilters(items, { ...DEFAULT_FILTERS, minHeight: 1100 }).items), ['c']);
});

test('min file size: unknown sizes are included or excluded explicitly', () => {
  assert.deepEqual(ids(applyFilters(items, { ...DEFAULT_FILTERS, minBytes: 100_000 }).items), ['a', 'c', 'd']);
  const r = applyFilters(items, { ...DEFAULT_FILTERS, minBytes: 100_000, unknownSize: 'exclude' });
  assert.deepEqual(ids(r.items), ['a']);
  assert.equal(r.hiddenUnknownSize, 2);
});

test('format, thumbnail and original-state filters', () => {
  assert.deepEqual(ids(applyFilters(items, { ...DEFAULT_FILTERS, formats: ['PNG', 'OTHER'] }).items), ['b', 'd']);
  assert.deepEqual(ids(applyFilters(items, { ...DEFAULT_FILTERS, excludeThumbnails: true }).items), ['a', 'c', 'd']);
  assert.deepEqual(ids(applyFilters(items, { ...DEFAULT_FILTERS, states: ['unknown'] }).items), ['b', 'd']);
});

test('filters keep relative order and do not modify items', () => {
  const before = JSON.stringify(items);
  const r = applyFilters(items, { ...DEFAULT_FILTERS, minWidth: 100, formats: ['JPEG', 'WEBP', 'PNG'] });
  assert.deepEqual(ids(r.items), ['a', 'b', 'c']);
  assert.equal(JSON.stringify(items), before);
});

test('filter input validation', () => {
  assert.deepEqual(parseLimit('', 100), { value: 0, error: null });
  assert.deepEqual(parseLimit(' 640 ', 100000), { value: 640, error: null });
  assert.equal(parseLimit('-5', 100).error, '0 이상이어야 합니다');
  assert.equal(parseLimit('abc', 100).error, '숫자를 입력하세요');
  assert.equal(parseLimit('1e400', 100).error, '숫자를 입력하세요');
  assert.deepEqual(parseLimit('99999999', 100000), { value: 100000, error: '최대 100,000까지 입력할 수 있습니다' });
});

test('formatBytes', () => {
  assert.equal(formatBytes(null), null);
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(2048), '2.0 KB');
  assert.equal(formatBytes(3 * 1024 * 1024), '3.00 MB');
});
