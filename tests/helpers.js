// Minimal image headers for parser/probe tests.
export function pngHeader(w, h) {
  const b = new Uint8Array(33);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(b.buffer).setUint32(16, w);
  new DataView(b.buffer).setUint32(20, h);
  return b;
}

export function jpegHeader(w, h, { orientation = 0, padding = 0 } = {}) {
  const parts = [[0xff, 0xd8]];
  if (orientation) {
    // APP1 Exif, big-endian TIFF, IFD0 with a single Orientation entry
    const tiff = [0x4d, 0x4d, 0, 42, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, orientation, 0, 0, 0, 0, 0, 0];
    const payload = [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff];
    const len = payload.length + 2;
    parts.push([0xff, 0xe1, len >> 8, len & 0xff, ...payload]);
  }
  if (padding) {
    const len = padding + 2;
    parts.push([0xff, 0xe0, len >> 8, len & 0xff, ...new Array(padding).fill(0)]);
  }
  parts.push([0xff, 0xc0, 0, 17, 8, h >> 8, h & 0xff, w >> 8, w & 0xff, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
  return Uint8Array.from(parts.flat());
}

export function gifHeader(w, h) {
  return Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, w & 0xff, w >> 8, h & 0xff, h >> 8, 0, 0, 0]);
}

export function webpVp8xHeader(w, h) {
  const b = new Uint8Array(30);
  b.set([...'RIFF'].map((c) => c.charCodeAt(0)), 0);
  b.set([...'WEBPVP8X'].map((c) => c.charCodeAt(0)), 8);
  const W = w - 1;
  const H = h - 1;
  b.set([W & 0xff, (W >> 8) & 0xff, (W >> 16) & 0xff, H & 0xff, (H >> 8) & 0xff, (H >> 16) & 0xff], 24);
  return b;
}

/** fetch() stand-in serving a table of url -> { status, type, body, length }. */
export function fakeFetch(table) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    const r = table[url];
    if (!r) return new Response('not found', { status: 404 });
    if (r.throws) throw new TypeError(r.throws);
    const headers = { 'content-type': r.type || 'image/jpeg' };
    if (r.total != null) {
      headers['content-range'] = `bytes 0-${r.body.length - 1}/${r.total}`;
      return new Response(r.body, { status: 206, headers });
    }
    return new Response(r.body, { status: r.status || 200, headers });
  };
  impl.calls = calls;
  return impl;
}
