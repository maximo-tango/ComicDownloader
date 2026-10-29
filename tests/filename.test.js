import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildFolder, decideFilename, isUsableName, NameRegistry, previewFilename, sanitizeFilename, siteFolderName, withImageExt } from '../extension/lib/filename.js';

test('sanitizeFilename removes characters Windows forbids', () => {
  assert.equal(sanitizeFilename('a<b>:c"d|e?f*.JPG'), 'a_b__c_d_e_f_.jpg');
  assert.equal(sanitizeFilename('  name. '), 'name');
  assert.equal(sanitizeFilename('CON.png'), '_CON.png');
});

test('usable vs unusable server names', () => {
  assert.equal(isUsableName('sunset.jpg'), true);
  assert.equal(isUsableName('1311912'), true);
  assert.equal(isUsableName('사진.png'), true);
  assert.equal(isUsableName('download'), false);
  assert.equal(isUsableName('image.php'), false);
  assert.equal(isUsableName('x.jpg?w=300'), false);
  assert.equal(isUsableName('a=1&b=2'), false);
  assert.equal(isUsableName('___.jpg'), false);
});

test('extension follows the real type', () => {
  assert.equal(withImageExt('photo', { mime: 'image/webp' }), 'photo.webp');
  assert.equal(withImageExt('photo.jpg', { mime: 'image/webp' }), 'photo.webp');
  assert.equal(withImageExt('photo.JPEG', { mime: 'image/jpeg' }), 'photo.jpg');
  assert.equal(withImageExt('photo.png', {}), 'photo.png');
  assert.equal(withImageExt('missing.txt', { mime: 'image/png' }), 'missing.png');
  assert.equal(withImageExt('view.php', { format: 'JPEG' }), 'view.jpg');
});

test('auto names image_001.. and collision suffixes', () => {
  const reg = new NameRegistry();
  const f = 'Image Hunter/site.test';
  assert.equal(decideFilename({ serverName: 'download', mime: 'image/png', folder: f, registry: reg }), 'image_001.png');
  assert.equal(decideFilename({ serverName: '', mime: 'image/jpeg', folder: f, registry: reg }), 'image_002.jpg');
  assert.equal(decideFilename({ serverName: 'cat.jpg', mime: 'image/jpeg', folder: f, registry: reg }), 'cat.jpg');
  assert.equal(decideFilename({ serverName: 'cat.jpg', mime: 'image/jpeg', folder: f, registry: reg }), 'cat_001.jpg');
  assert.equal(decideFilename({ serverName: 'CAT.jpg', mime: 'image/jpeg', folder: f, registry: reg }), 'CAT_002.jpg');
  // A different folder has its own namespace
  assert.equal(decideFilename({ serverName: 'cat.jpg', mime: 'image/jpeg', folder: 'Image Hunter/other', registry: reg }), 'cat.jpg');
});

test('auto numbering skips names already taken', () => {
  const reg = new NameRegistry();
  reg.claim('F', 'image_001.jpg');
  assert.equal(reg.nextAuto('F', 'jpg'), 'image_002.jpg');
});

test('custom names win and get the right extension', () => {
  const reg = new NameRegistry();
  assert.equal(decideFilename({ customName: '표지', serverName: 'x.jpg', mime: 'image/png', folder: 'F', registry: reg }), '표지.png');
  assert.equal(decideFilename({ customName: '표지.png', mime: 'image/png', folder: 'F', registry: reg }), '표지_001.png');
});

test('registry survives serialisation (service worker restarts)', () => {
  const reg = new NameRegistry();
  reg.nextAuto('F', 'jpg');
  reg.claim('F', 'a.jpg');
  const copy = new NameRegistry(JSON.parse(JSON.stringify(reg)));
  assert.equal(copy.nextAuto('F', 'jpg'), 'image_002.jpg');
  assert.equal(copy.claim('F', 'a.jpg'), 'a_001.jpg');
});

test('folders', () => {
  assert.equal(siteFolderName('https://www.example.com/a/b'), 'example.com');
  assert.equal(buildFolder({ rootFolder: 'Image Hunter', perSiteFolder: true }, 'https://www.example.com/x'), 'Image Hunter/example.com');
  assert.equal(buildFolder({ rootFolder: 'Image Hunter', perSiteFolder: false }, 'https://example.com'), 'Image Hunter');
  assert.equal(buildFolder({ rootFolder: 'Image Hunter', perSiteFolder: true, subFolder: '../모음:집' }, 'https://a.com'), 'Image Hunter/a.com/모음_집');
});

test('previewFilename ignores query strings and generic names', () => {
  assert.equal(previewFilename('https://a.com/p/photo.jpg?w=300&token=abc', 'JPEG'), 'photo.jpg');
  assert.equal(previewFilename('https://a.com/image.php?id=3', 'PNG'), null);
  assert.equal(previewFilename('https://a.com/media/abc123?format=jpg', 'JPEG'), 'abc123.jpg');
});
