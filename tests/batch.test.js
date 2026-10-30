import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSeries, findNumericParams, makeSeries, notFoundReason, pickFromLists, pickLinks, similarHint } from '../extension/lib/batch.js';

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

test('list page links: same site, similar to the list address, page order, no duplicates', () => {
  const list = 'https://a.com/webtoon/123';
  const links = [
    { url: 'https://a.com/', text: '홈' },
    { url: 'https://a.com/webtoon/123/9003', text: '' },
    { url: 'https://a.com/webtoon/123/9003#top', text: '3화' },
    { url: 'https://a.com/webtoon/123/9002', text: '  2화\n 제목 ' },
    { url: 'https://a.com/webtoon/123#comments', text: '댓글' },
    { url: 'https://a.com/webtoon/123?page=2', text: '다음 목록' },
    { url: 'https://a.com/webtoon/456/1', text: '다른 작품' },
    { url: 'https://b.com/webtoon/123/1', text: '다른 사이트' },
    { url: 'javascript:void(0)', text: 'x' },
    { url: 'not a url', text: 'x' },
    { url: 'https://a.com/webtoon/123/9001', text: '1화' },
  ];
  assert.deepEqual(pickLinks(list, links), [
    { url: 'https://a.com/webtoon/123/9003', text: '3화' },
    { url: 'https://a.com/webtoon/123/9002', text: '2화 제목' },
    { url: 'https://a.com/webtoon/123/9001', text: '1화' },
  ]);
  assert.deepEqual(pickLinks(list + '/', links).map((l) => l.text), ['3화', '2화 제목', '1화'], 'trailing slash on the list address');
  assert.deepEqual(pickLinks(list, links, { rule: 'site' }).map((l) => l.text), ['홈', '3화', '2화 제목', '다음 목록', '다른 작품', '1화']);
  assert.deepEqual(pickLinks(list, links, { rule: 'site', contains: '/webtoon/456' }).map((l) => l.text), ['다른 작품']);
  assert.deepEqual(pickLinks('bad', links), []);
});

test('list page links: query-style lists keep pages next to the list with the same id', () => {
  const list = 'https://comic.naver.com/webtoon/list?titleId=821597';
  const links = [
    { url: 'https://comic.naver.com/webtoon/detail?titleId=821597&no=116', text: '116화' },
    { url: 'https://comic.naver.com/webtoon/detail?titleId=999&no=1', text: '다른 작품' },
    { url: 'https://comic.naver.com/webtoon/list?titleId=821597&page=2', text: '2' },
    { url: 'https://comic.naver.com/webtoon/detail?titleId=821597&no=115', text: '115화' },
  ];
  assert.deepEqual(pickLinks(list, links).map((l) => l.text), ['116화', '115화']);
  assert.match(similarHint(list), /^\/webtoon\/list\/… 또는 titleId=821597이 같은 주소$/);
});

test('without a number (list page links), a redirect to another path means missing', () => {
  const req = 'https://a.com/webtoon/123/9002';
  assert.match(notFoundReason({ requestedUrl: req, finalUrl: 'https://a.com/webtoon/123', title: '목록' }), /다른 페이지로 이동됨/);
  assert.match(notFoundReason({ requestedUrl: req, finalUrl: 'https://a.com/login?next=x', title: '로그인' }), /다른 페이지로 이동됨/);
  assert.equal(notFoundReason({ requestedUrl: req, finalUrl: req + '/', title: '2화' }), '', 'trailing slash only');
  assert.equal(notFoundReason({ requestedUrl: req, finalUrl: req + '?from=list', title: '2화' }), '', 'query added');
});

test('several list pages: links appended in reading order, no duplicates, list pages left out', () => {
  const p1 = { url: 'https://a.com/webtoon/123', links: [
    { url: 'https://a.com/webtoon/123/9010', text: '10화' },
    { url: 'https://a.com/webtoon/123/9009', text: '' },
    { url: 'https://a.com/webtoon/123?page=2', text: '2' },
  ] };
  const p2 = { url: 'https://a.com/webtoon/123?page=2', links: [
    { url: 'https://a.com/webtoon/123', text: '1' },
    { url: 'https://a.com/webtoon/123/9009', text: '9화' },
    { url: 'https://a.com/webtoon/123/9008', text: '8화' },
  ] };
  assert.deepEqual(pickFromLists([p1, p2], { rule: 'similar' }).map((l) => `${l.text} ${l.url.slice(-4)}`), ['10화 9010', '9화 9009', '8화 9008']);
  assert.deepEqual(pickFromLists([p1, p2], { rule: 'site' }).map((l) => l.text), ['10화', '9화', '8화'], 'list pages themselves never become episodes');
  assert.deepEqual(pickFromLists([], { rule: 'site' }), []);
});

test('paging parameters do not count as the series id', () => {
  const list = 'https://comic.naver.com/webtoon/list?titleId=821597&page=2';
  const links = [
    { url: 'https://comic.naver.com/webtoon/detail?titleId=821597&no=96', text: '96화' },
    { url: 'https://comic.naver.com/webtoon/detail?titleId=5&page=2', text: '다른 작품' },
  ];
  assert.deepEqual(pickLinks(list, links).map((l) => l.text), ['96화']);
  assert.equal(similarHint(list), '/webtoon/list/… 또는 titleId=821597이 같은 주소');
});
