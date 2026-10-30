import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dedupeInOrder, mergeOrder, screenOrder } from '../extension/lib/ordering.js';
import { applyFilters, DEFAULT_FILTERS } from '../extension/lib/filters.js';
import { resolveEntry } from '../extension/lib/resolver.js';

test('rescan inserts new elements at their page position, not at the end', () => {
  assert.deepEqual(mergeOrder(['A', 'B', 'C'], ['A', 'X', 'B', 'C']), ['A', 'X', 'B', 'C']);
  assert.deepEqual(mergeOrder(['A', 'B', 'C'], ['X', 'A', 'B', 'C', 'Y']), ['X', 'A', 'B', 'C', 'Y']);
});

test('elements that left the page keep their place next to their neighbours', () => {
  // B was removed from the DOM (e.g. a virtualised list); D was added after C.
  assert.deepEqual(mergeOrder(['A', 'B', 'C'], ['A', 'C', 'D']), ['A', 'B', 'C', 'D']);
  assert.deepEqual(mergeOrder(['A', 'B', 'C'], []), ['A', 'B', 'C']);
  assert.deepEqual(mergeOrder([], ['A', 'B']), ['A', 'B']);
});

test('the page is the authority when elements really moved', () => {
  assert.deepEqual(mergeOrder(['A', 'B', 'C'], ['C', 'A', 'B']), ['C', 'A', 'B']);
});

test('merge is stable: rescanning the same page changes nothing', () => {
  const once = mergeOrder(['A', 'B', 'C'], ['A', 'X', 'C']);
  assert.deepEqual(mergeOrder(once, ['A', 'X', 'C']), once);
});

test('same URL: first occurrence is the representative', () => {
  const items = [
    { id: '1', u: 'https://s/a.jpg' },
    { id: '2', u: 'https://s/b.jpg' },
    { id: '3', u: 'https://s/a.jpg' },
    { id: '4', u: null },
    { id: '5', u: null },
  ];
  const { unique, duplicates } = dedupeInOrder(items, (x) => x.u);
  assert.deepEqual(unique.map((x) => x.id), ['1', '2', '4', '5']);
  assert.deepEqual([...duplicates], [['3', '1']]);
});

// The scenario from the spec: DOM order A, B, C; A has several candidates;
// C is the largest; alphabetical file names disagree with DOM order.
test('A/B/C scenario: order follows the page, never size or file name', async () => {
  const entries = [
    { key: 'A', displayUrl: 'https://s/zebra-small.jpg', natural: { w: 400, h: 300 }, rendered: { w: 400, h: 300 },
      candidates: [{ url: 'https://s/zebra-small.jpg', kind: 'src' }, { url: 'https://s/zebra-800.jpg', kind: 'srcset', w: 800 }, { url: 'https://s/zebra-1200.jpg', kind: 'srcset', w: 1200 }] },
    { key: 'B', displayUrl: 'https://s/apple.jpg', natural: { w: 600, h: 600 }, rendered: { w: 600, h: 600 }, candidates: [{ url: 'https://s/apple.jpg', kind: 'src' }] },
    { key: 'C', displayUrl: 'https://s/mango.jpg', natural: { w: 4000, h: 3000 }, rendered: { w: 400, h: 300 }, candidates: [{ url: 'https://s/mango.jpg', kind: 'src' }] },
  ];
  const sizes = { 'zebra-small': [400, 300], 'zebra-800': [800, 600], 'zebra-1200': [1200, 900], apple: [600, 600], mango: [4000, 3000] };
  const probe = async (u) => {
    const [w, h] = sizes[u.match(/s\/(.+)\.jpg/)[1]];
    return { ok: true, width: w, height: h, format: 'JPEG' };
  };
  const order = mergeOrder([], entries.map((e) => e.key));
  const items = new Map();
  // Resolve in reverse to prove completion order doesn't matter.
  for (const e of [...entries].reverse()) items.set(e.key, { id: e.key, ...(await resolveEntry(e, probe)) });
  const list = () => order.map((k) => items.get(k));

  assert.deepEqual(list().map((x) => x.id), ['A', 'B', 'C']);
  assert.equal(items.get('A').originalUrl, 'https://s/zebra-1200.jpg', 'A keeps its place with its best candidate');
  // Resolution filter: remaining items keep their relative order.
  const filtered = applyFilters(list(), { ...DEFAULT_FILTERS, minWidth: 700 }).items;
  assert.deepEqual(filtered.map((x) => x.id), ['A', 'C']);
  // Rescan with the same DOM: unchanged.
  assert.deepEqual(mergeOrder(order, ['A', 'B', 'C']), ['A', 'B', 'C']);
});

test('screenOrder: top to bottom, same row left to right, regardless of HTML order', () => {
  const at = (id, top, left = 0, h = 100) => ({ id, pos: { top, left, h } });
  // HTML order 3,1,4,2 but placed on screen as 1,2,3,4 (a shuffled strip)
  const strip = [at(3, 200), at(1, 0), at(4, 300), at(2, 100)];
  assert.deepEqual(screenOrder(strip).map((x) => x.id), [1, 2, 3, 4]);
  // a row of three whose tops differ by a few pixels, then one below
  const grid = [at('c', 3, 400), at('a', 0, 0), at('d', 120, 0), at('b', 1, 200)];
  assert.deepEqual(screenOrder(grid).map((x) => x.id), ['a', 'b', 'c', 'd']);
  // unpositioned items (hidden, iframe) stay right after the item before them in HTML order
  const mixed = [at('x', 100), { id: 'hidden' }, at('y', 0), { id: 'frame' }];
  assert.deepEqual(screenOrder(mixed).map((x) => x.id), ['y', 'frame', 'x', 'hidden']);
  assert.deepEqual(screenOrder([{ id: 1 }, { id: 2 }]).map((x) => x.id), [1, 2], 'no positions: unchanged');
  // already in order: unchanged (stable)
  const tall = [at(1, 0, 0, 2000), at(2, 2000, 0, 2000), at(3, 4000, 0, 1500)];
  assert.deepEqual(screenOrder(tall).map((x) => x.id), [1, 2, 3]);
});
