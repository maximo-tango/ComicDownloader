import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aspectRatioText, classifyUrl, formatFromUrl, toAbsoluteUrl, urlKey } from '../extension/lib/url-utils.js';

const base = 'https://example.com/gallery/page.html';

test('relative URLs become absolute', () => {
  assert.equal(classifyUrl('img/a.jpg', base).url, 'https://example.com/gallery/img/a.jpg');
  assert.equal(classifyUrl('/a.jpg', base).url, 'https://example.com/a.jpg');
  assert.equal(classifyUrl('//cdn.example.com/a.jpg', base).url, 'https://cdn.example.com/a.jpg');
  assert.equal(toAbsoluteUrl('../x.png', base), 'https://example.com/x.png');
});

test('URL kinds are separated, nothing throws', () => {
  assert.equal(classifyUrl('https://a.com/x.jpg').kind, 'http');
  assert.equal(classifyUrl('data:image/png;base64,AAAA').kind, 'data');
  assert.equal(classifyUrl('data:text/html,<script>').kind, 'unsupported');
  assert.equal(classifyUrl('blob:https://a.com/123-456').kind, 'blob');
  assert.equal(classifyUrl('javascript:alert(1)').kind, 'unsafe');
  assert.equal(classifyUrl(' JavaScript:alert(1)').kind, 'unsafe');
  assert.equal(classifyUrl('http://[bad').kind, 'invalid');
  assert.equal(classifyUrl('').kind, 'invalid');
  assert.equal(classifyUrl(null).kind, 'invalid');
  assert.equal(classifyUrl('ftp://a.com/x.jpg').kind, 'unsupported');
  assert.equal(toAbsoluteUrl('javascript:alert(1)', base), null);
});

test('de-duplication key is conservative: only the #fragment is ignored', () => {
  assert.equal(urlKey('https://a.com/x.jpg#top'), 'https://a.com/x.jpg');
  assert.notEqual(urlKey('https://a.com/x.jpg?w=300'), urlKey('https://a.com/x.jpg?w=1200'));
  assert.notEqual(urlKey('https://a.com/x.jpg?id=1'), urlKey('https://a.com/x.jpg'));
});

test('format guess from URL', () => {
  assert.equal(formatFromUrl('https://a.com/x.JPEG'), 'JPEG');
  assert.equal(formatFromUrl('https://a.com/x?format=webp'), 'WEBP');
  assert.equal(formatFromUrl('https://a.com/x'), null);
  assert.equal(formatFromUrl('data:image/svg+xml,<svg/>'), 'SVG');
});

test('aspect ratio text', () => {
  assert.equal(aspectRatioText(1920, 1080), '16:9');
  assert.equal(aspectRatioText(3000, 2000), '3:2');
  assert.equal(aspectRatioText(1000, 1414), '0.71');
  assert.equal(aspectRatioText(0, 10), null);
});
