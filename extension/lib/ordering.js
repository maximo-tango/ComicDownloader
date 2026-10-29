// Keeps the list in page (DOM) order across rescans.
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
