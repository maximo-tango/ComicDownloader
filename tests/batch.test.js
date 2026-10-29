import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSeries, findNumericParams, makeSeries, notFoundReason } from '../extension/lib/batch.js';

const NAVER = 'https://comic.naver.com/webtoon/detail?titleId=821597&no=116&week=tue';

test('finds numeric query and path parts, episode-like keys first', () => {
  const p = findNumericParams(NAVER);
  assert.deepEqual(p.map((x) => x.id), ['q:no', 'q:titleId']);
  assert.deepEqual(findNumericParams('https://a.com/comic/12/ep/007').map((x) => [x.kind, x.value]), [['path', '007'], ['path', '12']], 'last path number first');
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

test('no upper limit; open-ended series; validation', () => {
  const [no] = findNumericParams(NAVER);
  const big = makeSeries(NAVER, no, 1, 5000);
  assert.equal(big.count, 5000);
  assert.match(big.at(4999).url, /no=5000&/);
  assert.equal(big.at(5000), null);
  const open = makeSeries(NAVER, no, 10, '');
  assert.equal(open.count, null);
  assert.match(open.at(1000).url, /no=1010&/);
  const path = findNumericParams('https://a.com/webtoon/123/1000').find((p) => p.value === '1000');
  const down = makeSeries('https://a.com/webtoon/123/1000', path, 1000, 990, 5);
  assert.deepEqual([0, 1, 2, 3].map((i) => down.at(i)?.url), ['https://a.com/webtoon/123/1000', 'https://a.com/webtoon/123/995', 'https://a.com/webtoon/123/990', undefined]);
  assert.throws(() => buildSeries(NAVER, no, 'x', 3), /0 이상의 숫자/);
  assert.throws(() => makeSeries(NAVER, no, -1, 3), /0 이상의 숫자/);
});

test('not-found detection', () => {
  const [no] = findNumericParams(NAVER);
  const req = NAVER.replace('no=116', 'no=9999');
  // Naver: a missing episode redirects to the series list
  assert.match(notFoundReason({ requestedUrl: req, finalUrl: 'https://comic.naver.com/webtoon/list?titleId=821597', param: no, title: '괴력 난신 : 네이버 웹툰' }), /다른 페이지로 이동됨/);
  // a redirect that keeps the number (e.g. http → https, extra query) is fine
  assert.equal(notFoundReason({ requestedUrl: req, finalUrl: req + '&utm=x', param: no, title: '괴력 난신 - 9999화' }), '');
  assert.equal(notFoundReason({ status: 404, requestedUrl: req, finalUrl: req, param: no }), 'HTTP 404');
  assert.equal(notFoundReason({ status: 410 }), 'HTTP 410');
  assert.match(notFoundReason({ title: 'Page Not Found' }), /페이지 제목/);
  assert.match(notFoundReason({ title: '사이트', bodyText: '  요청하신 페이지를 찾을 수 없습니다. ' }), /페이지 내용/);
  // a long real page that mentions "404" somewhere is not "not found"
  assert.equal(notFoundReason({ title: '1화', bodyText: 'x '.repeat(500) + '404' }), '');
  assert.equal(notFoundReason({ title: '괴력 난신 - 116화. 조태청(1) : 네이버 웹툰', bodyText: null }), '');
  assert.match(notFoundReason({ title: '회차', bodyText: '아직 공개되지 않았습니다.' }), /페이지 내용/);
});

test('numbers inside a part ("nv-752414-1"): each digit run separately, the last one first', () => {
  const path = 'https://a.com/view/752414/nv-752414-1';
  const p = findNumericParams(path);
  assert.deepEqual(p.map((x) => x.value), ['1', '752414', '752414']);
  assert.equal(p[0].label, '경로의 /nv-752414-[1]/');
  assert.deepEqual(buildSeries(path, p[0], 1, 3).map((u) => u.url), [
    'https://a.com/view/752414/nv-752414-1', 'https://a.com/view/752414/nv-752414-2', 'https://a.com/view/752414/nv-752414-3',
  ]);
  assert.equal(buildSeries(path, p[0], 256, 256)[0].url, 'https://a.com/view/752414/nv-752414-256');

  const query = 'https://a.com/read?series=752414&v=nv-752414-1.html';
  const q = findNumericParams(query);
  const ep = q.find((x) => x.label === 'v=nv-752414-[1].html (주소의 ? 뒤)');
  assert.ok(ep, 'last run of a query value offered');
  assert.equal(buildSeries(query, ep, 7, 7)[0].url, 'https://a.com/read?series=752414&v=nv-752414-7.html');
  const [id] = findNumericParams('https://a.com/read?id=nv-752414-001');
  assert.equal(id.value, '001', 'episode-like key: its last number first');
  assert.equal(buildSeries('https://a.com/read?id=nv-752414-001', id, 12, 12)[0].url, 'https://a.com/read?id=nv-752414-012');
  assert.equal(notFoundReason({ requestedUrl: path, finalUrl: 'https://a.com/view/752414/', param: p[0] }).startsWith('다른 페이지로 이동됨'), true);
  assert.equal(notFoundReason({ requestedUrl: path, finalUrl: path + '?x=1', param: p[0] }), '');
});

test('percent escapes in a path are not numbers', () => {
  assert.deepEqual(findNumericParams('https://a.com/%EC%9B%B9%ED%88%B0-5').map((x) => x.value), ['5']);
});
