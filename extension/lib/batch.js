// URL series for "연속 PDF": find the numbers in a URL that can change, build
// the addresses from a start/end/step, and recognise addresses that don't exist.

/**
 * Numeric parts of a URL that can be varied.
 * @returns [{ id, kind: 'query'|'path', key?, index?, value, label }]
 */
export function findNumericParams(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    return [];
  }
  const out = [];
  for (const [key, value] of u.searchParams) {
    if (/^\d+$/.test(value)) out.push({ id: `q:${key}`, kind: 'query', key, value, label: `${key}=${value} (주소의 ? 뒤)` });
  }
  u.pathname.split('/').forEach((seg, index) => {
    if (/^\d+$/.test(seg)) out.push({ id: `p:${index}`, kind: 'path', index, value: seg, label: `경로의 ${seg} (/${seg}/)` });
  });
  // Most likely to change first: an episode-like query key ("no", "ep", "page" …),
  // then the last number in the path (".../series/123/4567" → 4567), then the rest.
  const lastPath = out.filter((p) => p.kind === 'path').at(-1);
  const likely = (p) => (p.kind === 'query' && /^(no|ep|episode|page|p|chapter|ch|n|num|id)$/i.test(p.key) ? 0 : p === lastPath ? 1 : 2);
  return out.sort((a, b) => likely(a) - likely(b));
}

/** Address for one number of the series (keeps zero padding: "007" → "008"). */
export function seriesUrl(raw, param, n) {
  const width = /^0\d/.test(param.value) ? param.value.length : 0;
  const v = width ? String(n).padStart(width, '0') : String(n);
  const u = new URL(raw);
  if (param.kind === 'query') u.searchParams.set(param.key, v);
  else {
    const segs = u.pathname.split('/');
    segs[param.index] = v;
    u.pathname = segs.join('/');
  }
  return u.href;
}

/**
 * The series as a lazy sequence (ranges can be large, or open-ended when
 * `end` is empty). @returns {{ count: number|null, at(i): { n, url } | null }}
 */
export function makeSeries(raw, param, start, end, step = 1) {
  const s = Math.trunc(Number(start));
  const open = end === '' || end == null;
  const e = open ? null : Math.trunc(Number(end));
  const st = Math.abs(Math.trunc(Number(step))) || 1;
  if (!Number.isFinite(s) || s < 0 || (!open && (!Number.isFinite(e) || e < 0))) throw new Error('시작·끝 번호는 0 이상의 숫자여야 합니다.');
  const dir = open || e >= s ? 1 : -1;
  const count = open ? null : Math.floor(Math.abs(e - s) / st) + 1;
  return {
    count,
    at(i) {
      if (count != null && i >= count) return null;
      const n = s + dir * st * i;
      return n < 0 ? null : { n, url: seriesUrl(raw, param, n) };
    },
  };
}

/** Finite series as an array (kept for callers and tests). */
export function buildSeries(raw, param, start, end, step = 1) {
  const series = makeSeries(raw, param, start, end, step);
  if (series.count == null) throw new Error('끝 번호가 없습니다.');
  return Array.from({ length: series.count }, (_, i) => series.at(i));
}

const NOT_FOUND_TEXT = /page not found|not found|404|존재하지 않|찾을 수 없|없는 페이지|삭제된 (게시물|페이지|글)|잘못된 (접근|경로|요청)|페이지가 없|권한이 없|공개되지 않|공개 예정/i;

/**
 * Does a response mean "this address doesn't exist"?
 *  - HTTP error status (404, 410, …)
 *  - redirected somewhere that no longer carries the number we asked for
 *    (e.g. a missing episode sends you to the series list)
 *  - a page whose title says "not found"; a very short body saying so counts too
 * @returns reason string, or '' when the page looks real
 */
export function notFoundReason({ status = 200, requestedUrl, finalUrl, param, title = '', bodyText = null }) {
  if (status >= 400) return `HTTP ${status}`;
  if (finalUrl && requestedUrl && finalUrl !== requestedUrl && param) {
    const want = valueOf(requestedUrl, param);
    const got = valueOf(finalUrl, param);
    if (want != null && got !== want) return `다른 페이지로 이동됨 (${shortUrl(finalUrl)})`;
  }
  if (NOT_FOUND_TEXT.test(title)) return `페이지 제목: ${title.trim().slice(0, 60)}`;
  if (bodyText != null) {
    const t = bodyText.replace(/\s+/g, ' ').trim();
    if (t.length < 400 && NOT_FOUND_TEXT.test(t)) return `페이지 내용: ${t.slice(0, 60)}`;
  }
  return '';
}

function valueOf(url, param) {
  try {
    const u = new URL(url);
    if (param.kind === 'query') return u.searchParams.get(param.key);
    return u.pathname.split('/')[param.index] ?? null;
  } catch {
    return null;
  }
}

function shortUrl(u) {
  try {
    const x = new URL(u);
    return x.host + x.pathname + x.search;
  } catch {
    return u;
  }
}
