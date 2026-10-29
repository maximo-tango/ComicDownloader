// Functions injected into the analysed page with chrome.scripting.executeScript({ func }).
// They are serialised, so each must be fully self-contained (no imports, no outer variables).

/**
 * Collects every image-bearing element in document order.
 * Each entry lists all URLs that could hold the picture (src, srcset,
 * enclosing link, lazy-load attributes …) — the app decides which is the original.
 */
export function collectImages(options) {
  const maxCssElements = (options && options.maxCssElements) || 40000;
  const IMG_EXT = /\.(jpe?g|jfif|pjpeg|pjp|png|apng|gif|webp|avif|bmp|svg|ico|tiff?|heic|heif)(?:$|[?#])/i;
  const LAZY_ATTRS = ['data-src', 'data-original', 'data-lazy-src', 'data-lazy', 'data-url', 'data-echo', 'data-img', 'data-image', 'data-actualsrc', 'data-defer-src', 'data-pagespeed-lazy-src'];
  const LAZY_SRCSET_ATTRS = ['data-srcset', 'data-lazy-srcset', 'data-original-set'];
  const HIRES_ATTRS = ['data-full', 'data-full-src', 'data-fullsrc', 'data-large', 'data-large-src', 'data-hi-res', 'data-hires', 'data-zoom-image', 'data-zoom-src', 'data-zoom', 'data-big', 'data-orig', 'data-orig-file', 'data-original-src', 'data-highres', 'data-raw'];

  const base = document.baseURI;
  const abs = (u) => {
    if (!u) return null;
    const s = String(u).trim();
    if (!s || /^(blob|javascript|about):/i.test(s)) return null;
    try {
      const url = new URL(s, base);
      return /^(https?|data):$/.test(url.protocol) ? url.href : null;
    } catch {
      return null;
    }
  };
  const looksLikeImage = (u) => !!u && (u.startsWith('data:image/') || IMG_EXT.test(new URL(u).pathname) || /[?&](format|fm|ext)=(jpe?g|png|webp|gif|avif)/i.test(u));

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
      const a = abs(url);
      if (!a) continue;
      const w = /(\d+)w/.exec(desc);
      const x = /([\d.]+)x/.exec(desc);
      out.push({ url: a, w: w ? Number(w[1]) : 0, x: x ? Number(x[1]) : 0 });
    }
    return out;
  };

  const cssUrls = (value) => {
    const out = [];
    if (!value || value === 'none') return out;
    const re = /url\(\s*(['"]?)(.*?)\1\s*\)/g;
    let m;
    while ((m = re.exec(value))) {
      const a = abs(m[2]);
      if (a) out.push(a);
    }
    return out;
  };

  const sizeOf = (el) => {
    const r = el.getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height), top: Math.round(r.top + window.scrollY) };
  };

  const entries = [];
  const seenKeys = new Set();
  let order = 0;
  const push = (entry) => {
    const key = entry.candidates.map((c) => c.url).sort().join('|');
    if (!key || seenKeys.has(key)) return;
    seenKeys.add(key);
    entry.order = order++;
    entries.push(entry);
  };

  const linkFor = (el) => {
    const a = el.closest && el.closest('a[href]');
    if (!a) return null;
    const href = abs(a.getAttribute('href'));
    return href && looksLikeImage(href) ? href : null;
  };

  const handleImg = (img) => {
    const candidates = [];
    const displayUrl = abs(img.currentSrc) || abs(img.getAttribute('src'));
    if (displayUrl) candidates.push({ url: displayUrl, kind: 'src' });
    const srcAttr = abs(img.getAttribute('src'));
    if (srcAttr && srcAttr !== displayUrl) candidates.push({ url: srcAttr, kind: 'src' });

    let isPicture = false;
    if (img.parentElement && img.parentElement.tagName === 'PICTURE') {
      isPicture = true;
      for (const source of img.parentElement.querySelectorAll('source')) {
        for (const c of parseSrcset(source.getAttribute('srcset') || source.getAttribute('data-srcset'))) {
          candidates.push({ url: c.url, kind: 'srcset', w: c.w, x: c.x });
        }
      }
    }
    for (const c of parseSrcset(img.getAttribute('srcset'))) candidates.push({ url: c.url, kind: 'srcset', w: c.w, x: c.x });
    for (const attr of LAZY_SRCSET_ATTRS) {
      for (const c of parseSrcset(img.getAttribute(attr))) candidates.push({ url: c.url, kind: 'srcset', w: c.w, x: c.x });
    }
    for (const attr of LAZY_ATTRS) {
      const a = abs(img.getAttribute(attr));
      if (a) candidates.push({ url: a, kind: 'lazy' });
    }
    for (const attr of HIRES_ATTRS) {
      const a = abs(img.getAttribute(attr));
      if (a) candidates.push({ url: a, kind: 'hires' });
    }
    const link = linkFor(img);
    if (link) candidates.push({ url: link, kind: 'link' });
    if (!candidates.length) return;

    const size = sizeOf(img);
    // A lazy placeholder (1x1 gif / data URI) is not what the user sees: prefer the real source.
    const shown = displayUrl && !/^data:/.test(displayUrl) ? displayUrl : (candidates.find((c) => !c.url.startsWith('data:')) || candidates[0]).url;
    push({
      elementType: isPicture ? 'picture' : 'img',
      displayUrl: shown,
      // naturalWidth describes currentSrc only; it says nothing about a not-yet-loaded lazy source.
      natural: shown === displayUrl && img.complete && img.naturalWidth ? { w: img.naturalWidth, h: img.naturalHeight } : null,
      rendered: { w: size.w, h: size.h },
      top: size.top,
      alt: (img.getAttribute('alt') || '').slice(0, 200),
      candidates,
    });
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
      const href = abs(el.getAttribute('href'));
      if (href && looksLikeImage(href) && !el.querySelector('img')) {
        const s = sizeOf(el);
        push({ elementType: 'a', displayUrl: href, natural: null, rendered: null, top: s.top, alt: (el.textContent || '').trim().slice(0, 200), candidates: [{ url: href, kind: 'link' }] });
      }
    } else if (tag === 'VIDEO') {
      const p = abs(el.getAttribute('poster'));
      if (p) {
        const s = sizeOf(el);
        push({ elementType: 'video', displayUrl: p, natural: null, rendered: { w: s.w, h: s.h }, top: s.top, candidates: [{ url: p, kind: 'poster' }] });
      }
    } else if (tag === 'INPUT' && (el.getAttribute('type') || '').toLowerCase() === 'image') {
      const p = abs(el.getAttribute('src'));
      if (p) push({ elementType: 'input', displayUrl: p, natural: null, rendered: null, top: sizeOf(el).top, candidates: [{ url: p, kind: 'src' }] });
    } else if (tag === 'image' || tag === 'IMAGE') {
      // <image> inside inline SVG
      const p = abs(el.getAttribute('href') || el.getAttribute('xlink:href'));
      if (p) push({ elementType: 'svg', displayUrl: p, natural: null, rendered: null, top: sizeOf(el).top, candidates: [{ url: p, kind: 'src' }] });
    }

    if (cssBudget-- > 0) {
      const urls = cssUrls(getComputedStyle(el).backgroundImage);
      if (urls.length) {
        const s = sizeOf(el);
        const hires = HIRES_ATTRS.map((a) => abs(el.getAttribute(a))).filter(Boolean);
        const link = linkFor(el);
        for (const u of urls) {
          const candidates = [{ url: u, kind: 'css' }];
          for (const h of hires) candidates.push({ url: h, kind: 'hires' });
          if (link) candidates.push({ url: link, kind: 'link' });
          push({ elementType: 'css', displayUrl: u, natural: null, rendered: { w: s.w, h: s.h }, top: s.top, candidates });
        }
      }
      // Lazy background images that are not applied yet
      for (const attr of ['data-bg', 'data-background', 'data-background-image', 'data-bg-src']) {
        const v = el.getAttribute(attr);
        const urls2 = v && /url\(/.test(v) ? cssUrls(v) : [abs(v)].filter(Boolean);
        for (const u of urls2) push({ elementType: 'css', displayUrl: u, natural: null, rendered: null, top: sizeOf(el).top, candidates: [{ url: u, kind: 'lazy' }] });
      }
    }
  }

  // Page-level images declared in meta tags come last.
  for (const sel of ['meta[property="og:image"]', 'meta[property="og:image:url"]', 'meta[name="twitter:image"]', 'link[rel="image_src"]']) {
    for (const m of document.querySelectorAll(sel)) {
      const u = abs(m.getAttribute('content') || m.getAttribute('href'));
      if (u) push({ elementType: 'meta', displayUrl: u, natural: null, rendered: null, top: 0, candidates: [{ url: u, kind: 'meta' }] });
    }
  }

  return {
    pageUrl: location.href,
    title: document.title,
    isTop: window.top === window,
    entries,
  };
}

/**
 * Scrolls the page to the bottom step by step so lazy-loaded images appear,
 * then returns to where the user was.
 */
export async function autoScroll(options) {
  const stepDelay = (options && options.stepDelay) || 450;
  const maxMs = (options && options.maxMs) || 60000;
  const el = document.scrollingElement || document.documentElement;
  const startY = el.scrollTop;
  const started = Date.now();
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  let stable = 0;
  let steps = 0;
  while (Date.now() - started < maxMs) {
    const before = el.scrollHeight;
    el.scrollBy(0, Math.max(200, Math.round(window.innerHeight * 0.85)));
    steps++;
    await wait(stepDelay);
    const atBottom = el.scrollTop + window.innerHeight >= el.scrollHeight - 4;
    if (atBottom && el.scrollHeight === before) {
      if (++stable >= 3) break;
      await wait(stepDelay);
    } else {
      stable = 0;
    }
  }
  // Let images that just entered the viewport finish loading.
  await wait(800);
  el.scrollTo(0, startY);
  return { steps, height: el.scrollHeight, timedOut: Date.now() - started >= maxMs };
}
