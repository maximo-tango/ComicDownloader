// Functions injected into the analysed page with chrome.scripting.executeScript({ func }).
// They are serialised, so each must be fully self-contained (no imports, no outer variables).
// They never modify the page's DOM: element identity is kept in a WeakMap that
// lives in the extension's isolated world, which persists between injections
// for the same document.

/**
 * Collects every image-bearing element in document order (CSS backgrounds and
 * <img> elements interleaved by DOM position). Each entry lists all URLs that
 * could hold the picture; the extension decides which one is the original.
 */
export function collectImages(options) {
  const maxCssElements = (options && options.maxCssElements) || 40000;
  const IMG_EXT = /\.(jpe?g|jfif|pjpeg|pjp|png|apng|gif|webp|avif|bmp|svg|ico|tiff?|heic|heif)$/i;
  // Attributes known to hold an image URL (lazy loaders / galleries).
  const LAZY_ATTRS = ['data-src', 'data-original', 'data-lazy-src', 'data-lazy', 'data-url', 'data-echo', 'data-img', 'data-image', 'data-actualsrc', 'data-defer-src', 'data-pagespeed-lazy-src'];
  const LAZY_SRCSET_ATTRS = ['data-srcset', 'data-lazy-srcset', 'data-original-set'];
  const HIRES_ATTRS = ['data-full', 'data-full-src', 'data-fullsrc', 'data-large', 'data-large-src', 'data-hi-res', 'data-hires', 'data-zoom-image', 'data-zoom-src', 'data-zoom', 'data-big', 'data-orig', 'data-orig-file', 'data-original-src', 'data-highres', 'data-raw'];
  const KNOWN = new Set([...LAZY_ATTRS, ...LAZY_SRCSET_ATTRS, ...HIRES_ATTRS, 'data-bg', 'data-background', 'data-background-image', 'data-bg-src']);

  // Per-document state in the isolated world: survives rescans, not navigations.
  const g = (globalThis.__imageHunter ||= {
    docId: Math.random().toString(36).slice(2, 10) + Date.now().toString(36),
    ids: new WeakMap(),
    next: 0,
  });
  const idOf = (el) => {
    let id = g.ids.get(el);
    if (id == null) {
      id = g.next++;
      g.ids.set(el, id);
    }
    return id;
  };

  const base = document.baseURI;
  // Never throws; unusable values are returned with a reason instead.
  const classify = (raw) => {
    const s = String(raw == null ? '' : raw).trim();
    if (!s) return null;
    if (/^(javascript|vbscript):/i.test(s)) return { kind: 'unsafe', url: s.slice(0, 200), error: '실행 가능한 URL은 허용하지 않음' };
    let u;
    try {
      u = new URL(s, base);
    } catch {
      return { kind: 'invalid', url: s.slice(0, 500), error: '잘못된 URL 형식' };
    }
    if (u.protocol === 'http:' || u.protocol === 'https:') return { kind: 'http', url: u.href };
    if (u.protocol === 'data:') return /^data:image\//i.test(u.href) ? { kind: 'data', url: u.href } : null;
    if (u.protocol === 'blob:') return { kind: 'blob', url: u.href, error: 'blob URL은 페이지 안에서만 유효해 다운로드할 수 없음' };
    if (u.protocol === 'about:') return null;
    return { kind: 'unsupported', url: u.href.slice(0, 500), error: `지원하지 않는 프로토콜 (${u.protocol})` };
  };
  const usable = (c) => c && (c.kind === 'http' || c.kind === 'data');
  const looksLikeImage = (u) => {
    if (u.startsWith('data:image/')) return true;
    try {
      const p = new URL(u);
      return IMG_EXT.test(p.pathname) || /[?&](format|fm|ext)=(jpe?g|png|webp|gif|avif)/i.test(p.search);
    } catch {
      return false;
    }
  };

  // HTML srcset parsing that tolerates commas inside URLs (e.g. CDN "w_300,h_200").
  const parseSrcset = (s) => {
    const out = [];
    if (!s) return out;
    let i = 0;
    while (i < s.length) {
      while (i < s.length && /[\s,]/.test(s[i])) i++;
      if (i >= s.length) break;
      let start = i;
      while (i < s.length && !/\s/.test(s[i])) i++;
      let url = s.slice(start, i);
      let desc = '';
      if (url.endsWith(',')) {
        url = url.replace(/,+$/, '');
      } else {
        start = i;
        let depth = 0;
        while (i < s.length && (s[i] !== ',' || depth > 0)) {
          if (s[i] === '(') depth++;
          else if (s[i] === ')') depth--;
          i++;
        }
        desc = s.slice(start, i).trim();
        i++;
      }
      const c = classify(url);
      if (!usable(c)) continue;
      const w = /(\d+)w/.exec(desc);
      const x = /([\d.]+)x/.exec(desc);
      out.push({ url: c.url, w: w ? Number(w[1]) : 0, x: x ? Number(x[1]) : 0 });
    }
    return out;
  };

  const cssUrls = (value) => {
    const out = [];
    if (!value || value === 'none') return out;
    const re = /url\(\s*(['"]?)(.*?)\1\s*\)/g;
    let m;
    while ((m = re.exec(value))) out.push(m[2]);
    return out;
  };

  const sizeOf = (el) => {
    const r = el.getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height), top: Math.round(r.top + window.scrollY) };
  };

  const entries = [];
  // key: stable per element (+ index for elements with several backgrounds)
  const push = (el, n, entry) => {
    entries.push({ key: `${g.docId}:${idOf(el)}:${n}`, ...entry });
  };
  const broken = (el, n, elementType, c) => {
    push(el, n, { elementType, displayUrl: c.url, urlKind: c.kind, urlError: c.error, natural: null, rendered: null, candidates: [] });
  };

  const linkFor = (el) => {
    const a = el.closest && el.closest('a[href]');
    if (!a) return null;
    const c = classify(a.getAttribute('href'));
    return usable(c) && looksLikeImage(c.url) ? c.url : null;
  };

  /** Validated extra data-* attributes: only values that really look like image URLs. */
  const genericDataUrls = (el) => {
    const out = [];
    for (const attr of el.attributes) {
      if (!attr.name.startsWith('data-') || KNOWN.has(attr.name)) continue;
      const v = attr.value.trim();
      if (!v || v.length > 2000 || /\s/.test(v)) continue;
      const c = classify(v);
      if (usable(c) && looksLikeImage(c.url)) out.push({ url: c.url, kind: 'hires', attr: attr.name });
    }
    return out;
  };

  const handleImg = (img) => {
    const candidates = [];
    const current = classify(img.currentSrc);
    const srcAttr = classify(img.getAttribute('src'));
    if (usable(current)) candidates.push({ url: current.url, kind: 'src', attr: 'currentSrc' });
    if (usable(srcAttr) && srcAttr.url !== current?.url) candidates.push({ url: srcAttr.url, kind: 'src', attr: 'src' });

    let isPicture = false;
    if (img.parentElement && img.parentElement.tagName === 'PICTURE') {
      isPicture = true;
      for (const source of img.parentElement.querySelectorAll('source')) {
        for (const c of parseSrcset(source.getAttribute('srcset') || source.getAttribute('data-srcset'))) {
          candidates.push({ url: c.url, kind: 'srcset', w: c.w, x: c.x, attr: 'source' });
        }
      }
    }
    for (const c of parseSrcset(img.getAttribute('srcset'))) candidates.push({ url: c.url, kind: 'srcset', w: c.w, x: c.x, attr: 'srcset' });
    for (const attr of LAZY_SRCSET_ATTRS) {
      for (const c of parseSrcset(img.getAttribute(attr))) candidates.push({ url: c.url, kind: 'srcset', w: c.w, x: c.x, attr });
    }
    for (const attr of LAZY_ATTRS) {
      const c = classify(img.getAttribute(attr));
      if (usable(c)) candidates.push({ url: c.url, kind: 'lazy', attr });
    }
    for (const attr of HIRES_ATTRS) {
      const c = classify(img.getAttribute(attr));
      if (usable(c)) candidates.push({ url: c.url, kind: 'hires', attr });
    }
    candidates.push(...genericDataUrls(img));
    const link = linkFor(img);
    if (link) candidates.push({ url: link, kind: 'link', attr: 'a.href' });

    if (!candidates.length) {
      // Nothing usable: keep the item visible with the reason (blob:, broken URL …).
      const bad = [srcAttr, current].find((c) => c && !usable(c));
      if (bad) broken(img, 0, 'img', bad);
      return;
    }
    const size = sizeOf(img);
    // A lazy placeholder (1x1 gif / data URI) is not what the user sees: prefer the real source.
    const displayUrl = usable(current) && current.kind === 'http' ? current.url : (candidates.find((c) => !c.url.startsWith('data:')) || candidates[0]).url;
    push(img, 0, {
      elementType: isPicture ? 'picture' : 'img',
      displayUrl,
      urlKind: displayUrl.startsWith('data:') ? 'data' : 'http',
      // naturalWidth describes currentSrc only; it says nothing about a not-yet-loaded lazy source.
      natural: usable(current) && displayUrl === current.url && img.complete && img.naturalWidth ? { w: img.naturalWidth, h: img.naturalHeight } : null,
      rendered: { w: size.w, h: size.h },
      sizes: img.getAttribute('sizes') || '',
      alt: (img.getAttribute('alt') || '').slice(0, 200),
      candidates,
    });
  };

  const single = (el, elementType, raw, kind) => {
    const c = classify(raw);
    if (!c) return;
    if (!usable(c)) return broken(el, 0, elementType, c);
    const s = sizeOf(el);
    push(el, 0, { elementType, displayUrl: c.url, urlKind: c.kind, natural: null, rendered: s.w ? { w: s.w, h: s.h } : null, candidates: [{ url: c.url, kind }] });
  };

  // Walk the DOM in document order, including open shadow roots.
  const elements = [];
  const walk = (root) => {
    const tw = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    let node = tw.currentNode.nodeType === 1 ? tw.currentNode : tw.nextNode();
    while (node) {
      elements.push(node);
      if (node.shadowRoot) walk(node.shadowRoot);
      node = tw.nextNode();
    }
  };
  walk(document.documentElement);

  let cssBudget = maxCssElements;
  for (const el of elements) {
    const tag = el.tagName;
    if (tag === 'IMG') {
      handleImg(el);
    } else if (tag === 'A') {
      const c = classify(el.getAttribute('href'));
      if (usable(c) && looksLikeImage(c.url) && !el.querySelector('img')) single(el, 'a', c.url, 'link');
    } else if (tag === 'VIDEO' && el.getAttribute('poster')) {
      single(el, 'video', el.getAttribute('poster'), 'poster');
    } else if (tag === 'INPUT' && (el.getAttribute('type') || '').toLowerCase() === 'image') {
      single(el, 'input', el.getAttribute('src'), 'src');
    } else if (tag === 'image' || tag === 'IMAGE') {
      single(el, 'svg', el.getAttribute('href') || el.getAttribute('xlink:href'), 'src');
    }

    if (cssBudget-- > 0) {
      // Every url() of a multi-background is its own entry, at this element's position.
      const raws = cssUrls(getComputedStyle(el).backgroundImage);
      for (const attr of ['data-bg', 'data-background', 'data-background-image', 'data-bg-src']) {
        const v = el.getAttribute(attr);
        if (v) raws.push(...(/url\(/.test(v) ? cssUrls(v) : [v]));
      }
      if (raws.length) {
        const s = sizeOf(el);
        const extra = HIRES_ATTRS.map((a) => classify(el.getAttribute(a))).filter(usable).map((c) => ({ url: c.url, kind: 'hires' }));
        const link = linkFor(el);
        const seen = new Set();
        raws.forEach((raw, i) => {
          const c = classify(raw);
          if (!c || seen.has(c.url)) return;
          seen.add(c.url);
          const n = i + 1; // 0 is reserved for the element's own image
          if (!usable(c)) return broken(el, n, 'css', c);
          const candidates = [{ url: c.url, kind: 'css' }, ...extra];
          if (link) candidates.push({ url: link, kind: 'link' });
          push(el, n, { elementType: 'css', displayUrl: c.url, urlKind: c.kind, natural: null, rendered: s.w ? { w: s.w, h: s.h } : null, candidates });
        });
      }
    }
  }

  // Page-level images declared in meta tags come last.
  for (const sel of ['meta[property="og:image"]', 'meta[property="og:image:url"]', 'meta[name="twitter:image"]', 'link[rel="image_src"]']) {
    for (const m of document.querySelectorAll(sel)) {
      const c = classify(m.getAttribute('content') || m.getAttribute('href'));
      if (usable(c)) push(m, 0, { elementType: 'meta', displayUrl: c.url, urlKind: c.kind, natural: null, rendered: null, candidates: [{ url: c.url, kind: 'meta' }] });
    }
  }

  return { docId: g.docId, pageUrl: location.href, title: document.title, isTop: window.top === window, entries };
}

/**
 * Scrolls down screen by screen so lazy-loaded images appear, bounded by
 * maxScreens and maxMs (never endless on infinite-scroll pages), then returns
 * the user to where they were. A later call with resume: true continues from
 * where the previous one stopped.
 */
export async function autoScroll(options) {
  const stepDelay = (options && options.stepDelay) || 450;
  const maxMs = (options && options.maxMs) || 60000;
  const maxScreens = (options && options.maxScreens) || 30;
  const g = (globalThis.__imageHunterScroll ||= { resumeY: 0 });
  const el = document.scrollingElement || document.documentElement;
  const startY = el.scrollTop;
  if (options && options.resume && g.resumeY > startY) el.scrollTo(0, g.resumeY);
  const started = Date.now();
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  let stable = 0;
  let screens = 0;
  let reachedEnd = false;
  while (Date.now() - started < maxMs && screens < maxScreens) {
    const before = el.scrollHeight;
    el.scrollBy(0, Math.max(200, Math.round(window.innerHeight * 0.85)));
    screens++;
    await wait(stepDelay);
    const atBottom = el.scrollTop + window.innerHeight >= el.scrollHeight - 4;
    if (atBottom && el.scrollHeight === before) {
      if (++stable >= 3) {
        reachedEnd = true;
        break;
      }
      await wait(stepDelay);
    } else {
      stable = 0;
    }
  }
  // Let images that just entered the viewport finish loading.
  await wait(800);
  g.resumeY = el.scrollTop;
  el.scrollTo(0, startY);
  return { screens, reachedEnd, height: el.scrollHeight };
}

/**
 * Links on the page in document order (for "목록 페이지에서 링크 추출").
 * Read-only; the extension decides which ones to keep.
 */
export function collectLinks() {
  const links = [];
  for (const a of document.querySelectorAll('a[href]')) {
    if (typeof a.href !== 'string') continue; // SVG <a>
    const text = (a.innerText || a.getAttribute('title') || a.querySelector('img[alt]')?.alt || '').trim().slice(0, 200);
    links.push({ url: a.href, text });
  }
  return { pageUrl: location.href, title: document.title, links };
}

/**
 * Reads an image through the page itself (same-origin images, the page's own
 * cookies) and returns it as a data: URL. Used only to build PDFs when the
 * extension cannot read the file directly; it does not bypass CORS.
 */
export async function readImageInPage(url) {
  try {
    const resp = await fetch(url, { credentials: 'include' });
    if (!resp.ok) return { ok: false, error: `HTTP ${resp.status}` };
    const blob = await resp.blob();
    const dataUrl = await new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = () => reject(r.error);
      r.readAsDataURL(blob);
    });
    return { ok: true, dataUrl };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}
