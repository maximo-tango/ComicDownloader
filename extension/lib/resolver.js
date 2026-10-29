// Original-image resolution: turns one collected page entry (an <img>, a CSS
// background, a link…) into a single item pointing at the best verified URL.
//
// Candidate priority (lower = preferred when sizes tie):
//   1 srcset (largest descriptor)   2 linked image / hi-res data attribute
//   3 the directly displayed URL    4 anything without a verifiable resolution
// URL strings alone never confirm an original: every candidate is probed and
// the choice is made on real pixel sizes, recording where it came from.
// Guessing URLs by stripping "thumb"/"small" etc. is NOT part of the default
// logic; it only runs when the user enables it (guessVariants), and even then
// a guess is used only if it really exists and has the same shape.

import { formatFromUrl, urlKey } from './url-utils.js';
import { generateVariants, hasThumbMarker } from './variants.js';

export const PRIORITY = { srcset: 1, link: 2, hires: 2, variant: 3, src: 4, lazy: 4, css: 4, poster: 4, meta: 4 };

export const SOURCE_LABEL = {
  src: 'src', srcset: 'srcset', link: '링크', hires: '고해상도 속성', variant: '변형 URL',
  lazy: '지연 로딩 속성', css: 'CSS 배경', poster: '비디오 포스터', meta: '메타 태그',
};

export const CONFIDENCE = { HIGH: '높음', MEDIUM: '보통', UNSURE: '확인 필요' };

/** Original-candidate states shown to the user. */
export const ORIGINAL_STATE = {
  confirmed: '원본 후보 확인',
  hires: '고해상도 후보',
  compare: '후보 비교 필요',
  unknown: '확인 불가',
};

export const DEFAULT_RESOLVE_OPTIONS = { thumbMaxSide: 300, maxVariants: 6, guessVariants: false };

/** Expands an entry's candidates with variants and removes duplicates. */
export function buildCandidates(entry, opts = DEFAULT_RESOLVE_OPTIONS) {
  const list = [];
  const seen = new Map();
  const add = (c) => {
    const key = urlKey(c.url);
    if (!key) return;
    const prev = seen.get(key);
    if (prev) {
      // Keep the most trusted origin for a URL found several ways.
      if (PRIORITY[c.kind] < PRIORITY[prev.kind]) Object.assign(prev, c, { url: prev.url });
      return;
    }
    const copy = { ...c };
    seen.set(key, copy);
    list.push(copy);
  };
  for (const c of entry.candidates) add(c);

  if (!opts.guessVariants) return list;
  // Variants are derived from the displayed URL and from the best srcset entry.
  const bases = [entry.displayUrl, bestSrcset(entry.candidates)?.url].filter(Boolean);
  for (const base of new Set(bases)) {
    for (const v of generateVariants(base, opts.maxVariants)) add({ url: v.url, kind: 'variant', rule: v.rule, from: base });
  }
  return list;
}

export function bestSrcset(candidates) {
  let best = null;
  for (const c of candidates) {
    if (c.kind !== 'srcset') continue;
    const score = c.w || (c.x ? c.x * 1e4 : 1);
    if (!best || score > best.score) best = { ...c, score };
  }
  return best;
}

const aspect = (w, h) => (w > 0 && h > 0 ? w / h : null);
const sameAspect = (a, b) => a && b && Math.abs(Math.log(a / b)) < 0.06;

/**
 * Picks the original among probed candidates.
 * @param entry  collected entry (rendered/natural sizes, displayUrl)
 * @param probed candidates, each with `.probe` = { ok, width, height, format, bytes, mime, error }
 */
export function chooseOriginal(entry, probed, opts = DEFAULT_RESOLVE_OPTIONS) {
  const ok = probed.filter((c) => c.probe?.ok);
  const sized = ok.filter((c) => c.probe.width > 0 && c.probe.height > 0);

  // Reference aspect ratio: what the page actually shows.
  const displayed = probed.find((c) => urlKey(c.url) === urlKey(entry.displayUrl));
  const refAspect =
    aspect(entry.natural?.w, entry.natural?.h) ||
    aspect(displayed?.probe?.width, displayed?.probe?.height);
  const displayArea = (entry.natural?.w || displayed?.probe?.width || 0) * (entry.natural?.h || displayed?.probe?.height || 0);

  // Links and guessed variants may point at a *different* image; only trust
  // them when their shape matches the displayed one.
  const accepted = sized.filter((c) => {
    if (!['link', 'hires', 'variant'].includes(c.kind) || !refAspect) return true;
    return sameAspect(refAspect, aspect(c.probe.width, c.probe.height));
  });

  // Bigger images we refused because their shape differs: the user should compare.
  const rejectedLarger = sized.some((c) => !accepted.includes(c));

  let chosen = null;
  for (const c of accepted) {
    if (!chosen) { chosen = c; continue; }
    const a = c.probe.width * c.probe.height;
    const b = chosen.probe.width * chosen.probe.height;
    if (a > b || (a === b && PRIORITY[c.kind] < PRIORITY[chosen.kind])) chosen = c;
  }

  let originalStatus;
  if (chosen) {
    originalStatus = displayArea && chosen.probe.width * chosen.probe.height > displayArea * 1.05 ? 'found' : 'self';
  } else {
    // Nothing verifiable: fall back to a reachable URL, else the displayed one.
    chosen =
      [...ok].sort((a, b) => PRIORITY[a.kind] - PRIORITY[b.kind])[0] ||
      displayed ||
      probed[0];
    originalStatus = 'none';
  }

  const p = chosen.probe || {};
  const width = p.width || (urlKey(chosen.url) === urlKey(entry.displayUrl) ? entry.natural?.w : 0) || 0;
  const height = p.height || (urlKey(chosen.url) === urlKey(entry.displayUrl) ? entry.natural?.h : 0) || 0;
  const thumbMarker = hasThumbMarker(chosen.url);
  const small = width > 0 && Math.max(width, height) < opts.thumbMaxSide;

  let score;
  if (!(width > 0)) {
    score = 0.2;
  } else {
    score = { srcset: 0.8, link: 0.85, hires: 0.85, variant: 0.7 }[chosen.kind] ?? 0.6;
    if (originalStatus === 'found') score += 0.1;
    // The page shows the picture smaller than its real size: a strong sign this is the full file.
    const r = entry.rendered;
    if (r?.w > 0 && r?.h > 0 && width * height > r.w * r.h * 1.5) score += 0.15;
    if (thumbMarker) score -= 0.3;
    if (small) score -= 0.3;
    if (['link', 'hires', 'variant'].includes(chosen.kind) && !refAspect) score -= 0.2;
  }
  score = Math.max(0, Math.min(1, Math.round(score * 100) / 100));
  const confidenceLabel = score >= 0.75 ? CONFIDENCE.HIGH : score >= 0.5 ? CONFIDENCE.MEDIUM : CONFIDENCE.UNSURE;

  const isThumbnail = small || (thumbMarker && originalStatus !== 'found') ||
    (!(width > 0) && entry.rendered?.w > 0 && Math.max(entry.rendered.w, entry.rendered.h) < opts.thumbMaxSide);

  let originalState;
  // Size known only from the page, but the extension cannot reach the URL: not verified.
  if (!(width > 0) || !chosen.probe?.ok) originalState = 'unknown';
  else if (score < 0.5 || isThumbnail || rejectedLarger) originalState = 'compare';
  else if (originalStatus === 'found') originalState = 'hires';
  else originalState = 'confirmed';

  return {
    originalUrl: chosen.url,
    originalState,
    sourceUrl: entry.frameUrl || entry.pageUrl,
    sourceType: chosen.kind,
    width,
    height,
    format: p.format || formatFromUrl(chosen.url) || null,
    // true when the format came from the file's bytes or MIME type, not the URL
    formatVerified: !!p.formatVerified,
    serverName: p.serverName || '',
    bytes: p.bytes ?? null,
    mime: p.mime || null,
    isThumbnail,
    originalConfidence: score,
    confidenceLabel,
    originalStatus,
    displayUrl: entry.displayUrl,
    rendered: entry.rendered || null,
    order: entry.order,
    elementType: entry.elementType,
    candidates: probed.map((c) => ({
      url: c.url,
      kind: c.kind,
      rule: c.rule,
      ok: !!c.probe?.ok,
      width: c.probe?.width || 0,
      height: c.probe?.height || 0,
      format: c.probe?.format || null,
      formatVerified: !!c.probe?.formatVerified,
      mime: c.probe?.mime || null,
      serverName: c.probe?.serverName || '',
      bytes: c.probe?.bytes ?? null,
      error: c.probe?.error || null,
      chosen: c === chosen,
    })),
  };
}

/** Probes every candidate (via the injected `probe(url, hint)`) and chooses. */
export async function resolveEntry(entry, probe, opts = DEFAULT_RESOLVE_OPTIONS) {
  const candidates = buildCandidates(entry, opts);
  await Promise.all(
    candidates.map(async (c) => {
      const hint = urlKey(c.url) === urlKey(entry.displayUrl) && entry.natural?.w ? entry.natural : null;
      c.probe = await probe(c.url, hint);
    }),
  );
  return chooseOriginal(entry, candidates, opts);
}

/**
 * The user picked another candidate for an item. Returns the fields to update;
 * the item keeps its place in the list and its selection.
 */
export function selectCandidate(item, url) {
  const c = item.candidates.find((x) => x.url === url);
  if (!c) return null;
  return {
    originalUrl: c.url,
    sourceType: c.kind,
    width: c.width,
    height: c.height,
    format: c.format || formatFromUrl(c.url),
    bytes: c.bytes ?? null,
    formatVerified: !!c.formatVerified,
    mime: c.mime || null,
    serverName: c.serverName || '',
    userChosen: true,
    candidates: item.candidates.map((x) => ({ ...x, chosen: x.url === url })),
  };
}
