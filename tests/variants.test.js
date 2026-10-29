import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateVariants, hasThumbMarker } from '../extension/lib/variants.js';

const urls = (u) => generateVariants(u).map((v) => v.url);

test('WordPress size suffix', () => {
  assert.ok(urls('https://a.com/wp-content/uploads/2024/05/photo-300x200.jpg').includes('https://a.com/wp-content/uploads/2024/05/photo.jpg'));
  assert.ok(urls('https://a.com/u/photo-scaled.jpg').includes('https://a.com/u/photo.jpg'));
});

test('thumb suffix and thumbnail directories', () => {
  assert.ok(urls('https://a.com/img/cat_thumb.png').includes('https://a.com/img/cat.png'));
  const v = urls('https://a.com/gallery/thumbs/cat.jpg');
  assert.ok(v.includes('https://a.com/gallery/cat.jpg'));
  assert.ok(v.includes('https://a.com/gallery/original/cat.jpg'));
});

test('query size parameters and name=small', () => {
  assert.ok(urls('https://cdn.a.com/x.jpg?w=300&h=200&id=7').includes('https://cdn.a.com/x.jpg?id=7'));
  assert.ok(urls('https://pbs.example.com/media/abc?format=jpg&name=small').includes('https://pbs.example.com/media/abc?format=jpg&name=orig'));
});

test('CDN transformation segment and Google-style size suffix', () => {
  assert.ok(urls('https://res.cdn.com/demo/image/upload/w_300,h_200,c_fill/sample.jpg').includes('https://res.cdn.com/demo/image/upload/sample.jpg'));
  assert.ok(urls('https://lh3.example.com/abcdef=w300-h200').includes('https://lh3.example.com/abcdef=s0'));
});

test('ordinary URLs produce no variants', () => {
  assert.deepEqual(urls('https://a.com/images/2024/sunset.jpg'), []);
  assert.deepEqual(urls('data:image/png;base64,AAAA'), []);
});

test('thumbnail markers', () => {
  assert.equal(hasThumbMarker('https://a.com/thumbs/x.jpg'), true);
  assert.equal(hasThumbMarker('https://a.com/x_thumb.jpg'), true);
  assert.equal(hasThumbMarker('https://a.com/x-150x150.jpg'), true);
  assert.equal(hasThumbMarker('https://a.com/m?name=small'), true);
  assert.equal(hasThumbMarker('https://a.com/images/low-carb-recipe.jpg'), false);
  assert.equal(hasThumbMarker('https://a.com/photos/sunset.jpg'), false);
});
