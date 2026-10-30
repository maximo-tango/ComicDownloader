// Keeps the list in page (DOM) order across rescans, and can re-order it the
// way the page shows it on screen (screenOrder).
//
// mergeOrder(previous, scanned) returns one sequence where:
//  - every key of `scanned` appears in scanned order (the page is the authority),
//  - new keys are inserted where the page has them, not appended,
//  - keys that vanished from the page (removed / virtualised elements) stay next
//    to the neighbours they had, so finished downloads and selections keep their place.
export function mergeOrder(previous, scanned) {
  const inScan = new Set(scanned);
  const prevIndex = new Map(previous.map((k, i) => [k, i]));
  const out = [];
  const emitted = new Set();
  let p = 0; // position in `previous`
  const emit = (k) => {
    if (!emitted.has(k)) {
      emitted.add(k);
      out.push(k);
    }
  };
  for (const key of scanned) {
    const j = prevIndex.get(key);
    if (j !== undefined && j >= p) {
      // Flush vanished keys that sat before this one.
      for (; p < j; p++) if (!inScan.has(previous[p])) emit(previous[p]);
      p = j + 1;
    }
    emit(key);
  }
  for (; p < previous.length; p++) if (!inScan.has(previous[p])) emit(previous[p]);
  // Vanished keys whose neighbours moved past them.
  for (const k of previous) emit(k);
  return out;
}

/**
 * Order-preserving de-duplication: the first occurrence of each URL key is the
 * representative; later ones are reported as duplicates of it.
 * @returns {{ unique: object[], duplicates: Map<string, string> }}
 */
export function dedupeInOrder(items, keyOf) {
  const first = new Map();
  const unique = [];
  const duplicates = new Map();
  for (const it of items) {
    const k = keyOf(it);
    if (k && first.has(k)) {
      duplicates.set(it.id, first.get(k));
      continue;
    }
    if (k) first.set(k, it.id);
    unique.push(it);
  }
  return { unique, duplicates };
}

/**
 * Re-orders items the way they appear on screen: top to bottom, and left to
 * right for items on the same row. Pages can lay pictures out in a different
 * order than their HTML (CSS `order`, grid, absolute positioning).
 * Items without a position (hidden, from an iframe) stay right after the
 * positioned item that precedes them in page order. Stable otherwise.
 * @param posOf item → { top, left, h } | null
 */
export function screenOrder(items, posOf = (it) => it.pos) {
  let anchor = { top: -Infinity, left: -Infinity, h: 0 };
  const rows = items.map((it, i) => {
    const p = posOf(it);
    if (p) anchor = p;
    return { it, i, p: p || anchor };
  });
  rows.sort((a, b) => a.p.top - b.p.top || a.i - b.i);
  // Group into rows: an item whose top is within half the (smaller) height of
  // the row's first item sits beside it, so left decides.
  const out = [];
  for (let s = 0; s < rows.length; ) {
    const first = rows[s].p;
    let e = s + 1;
    while (e < rows.length && rows[e].p.top - first.top < Math.max(4, Math.min(first.h, rows[e].p.h) / 2)) e++;
    out.push(...rows.slice(s, e).sort((a, b) => a.p.left - b.p.left || a.i - b.i));
    s = e;
  }
  return out.map((r) => r.it);
}
