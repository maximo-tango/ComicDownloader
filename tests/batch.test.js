import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSeries, findNumericParams, MAX_BATCH } from '../extension/lib/batch.js';

const NAVER = 'https://comic.naver.com/webtoon/detail?titleId=821597&no=116&week=tue';

test('finds numeric query and path parts, episode-like keys first', () => {
  const p = findNumericParams(NAVER);
  assert.deepEqual(p.map((x) => x.id), ['q:no', 'q:titleId']);
  assert.deepEqual(findNumericParams('https://a.com/comic/12/ep/007').map((x) => [x.kind, x.value]), [['path', '12'], ['path', '007']]);
  assert.deepEqual(findNumericParams('not a url'), []);
});

test('builds the series, changing only the chosen part', () => {
  const [no] = findNumericParams(NAVER);
  const urls = buildSeries(NAVER, no, 114, 116);
  assert.deepEqual(urls.map((u) => u.url), [
    'https://comic.naver.com/webtoon/detail?titleId=821597&no=114&week=tue',
    'https://comic.naver.com/webtoon/detail?titleId=821597&no=115&week=tue',
    'https://comic.naver.com/webtoon/detail?titleId=821597&no=116&week=tue',
  ]);
  assert.deepEqual(buildSeries(NAVER, no, 10, 4, 3).map((u) => u.n), [10, 7, 4], 'counting down with a step');
});

test('path numbers keep zero padding', () => {
  const p = findNumericParams('https://a.com/comic/12/ep/007/view').find((x) => x.value === '007');
  assert.deepEqual(buildSeries('https://a.com/comic/12/ep/007/view', p, 9, 11).map((u) => u.url), [
    'https://a.com/comic/12/ep/009/view', 'https://a.com/comic/12/ep/010/view', 'https://a.com/comic/12/ep/011/view',
  ]);
});

test('limits and validation', () => {
  const [no] = findNumericParams(NAVER);
  assert.equal(buildSeries(NAVER, no, 1, MAX_BATCH).length, MAX_BATCH);
  assert.throws(() => buildSeries(NAVER, no, 1, MAX_BATCH + 1), /최대 200개/);
  assert.throws(() => buildSeries(NAVER, no, 'x', 3), /0 이상의 숫자/);
  assert.throws(() => buildSeries(NAVER, no, -1, 3), /0 이상의 숫자/);
});
