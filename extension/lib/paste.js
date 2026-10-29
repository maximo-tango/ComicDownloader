// Parses the "paste URLs" box: one URL per line, optionally followed by a
// file name ("https://a.com/x.jpg  my-name.jpg"). Lines starting with # are comments.

import { urlKey } from './url-utils.js';

export function parseUrlList(text) {
  const valid = [];
  const invalid = [];
  const seen = new Set();
  let duplicates = 0;
  const lines = String(text || '').split(/\r?\n/);
  lines.forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    const [first, ...rest] = line.split(/\s+/);
    let url;
    try {
      url = new URL(first);
    } catch {
      invalid.push({ line: i + 1, text: line, reason: 'URL 형식이 아님' });
      return;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      invalid.push({ line: i + 1, text: line, reason: 'HTTP/HTTPS 주소만 지원' });
      return;
    }
    const key = urlKey(url.href);
    if (seen.has(key)) {
      duplicates++;
      return;
    }
    seen.add(key);
    valid.push({ line: i + 1, url: url.href, customName: rest.join(' ').trim() });
  });
  return { valid, invalid, duplicates };
}
