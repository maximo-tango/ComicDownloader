// URL series for "연속 PDF": find the numbers in a URL that can change and
// build the list of addresses from a start/end/step.

export const MAX_BATCH = 200;

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
  // Episode numbers are usually the last query value; put a likely "no"/"ep"/"page" first.
  const likely = (p) => (p.kind === 'query' && /^(no|ep|episode|page|p|chapter|ch|n|num|id)$/i.test(p.key) ? 0 : 1);
  return out.sort((a, b) => likely(a) - likely(b));
}

/** Builds the URL series. Keeps zero padding ("007" → "008"). */
export function buildSeries(raw, param, start, end, step = 1) {
  const s = Math.trunc(Number(start));
  const e = Math.trunc(Number(end));
  const st = Math.abs(Math.trunc(Number(step))) || 1;
  if (!Number.isFinite(s) || !Number.isFinite(e) || s < 0 || e < 0) throw new Error('시작·끝 번호는 0 이상의 숫자여야 합니다.');
  const count = Math.floor(Math.abs(e - s) / st) + 1;
  if (count > MAX_BATCH) throw new Error(`한 번에 최대 ${MAX_BATCH}개까지 만들 수 있습니다 (지금 ${count}개).`);
  const width = /^0\d/.test(param.value) ? param.value.length : 0;
  const dir = e >= s ? 1 : -1;
  const urls = [];
  for (let i = 0, n = s; i < count; i++, n += dir * st) {
    const v = width ? String(n).padStart(width, '0') : String(n);
    const u = new URL(raw);
    if (param.kind === 'query') u.searchParams.set(param.key, v);
    else {
      const segs = u.pathname.split('/');
      segs[param.index] = v;
      u.pathname = segs.join('/');
    }
    urls.push({ n, url: u.href });
  }
  return urls;
}
