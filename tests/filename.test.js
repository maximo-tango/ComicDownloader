import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildFolder, decideFilename, fallbackBaseName, isUsableName, NameRegistry, previewFilename, sanitizeFilename, siteFolderName, withImageExt } from '../extension/lib/filename.js';

const name = (args) => decideFilename(args).name;

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

test('auto names and "name (1)" collisions', () => {
  const reg = new NameRegistry();
  const f = 'ImageHunter/페이지';
  assert.equal(name({ serverName: 'download', mime: 'image/png', folder: f, registry: reg }), 'image_001.png');
  assert.equal(name({ serverName: '', mime: 'image/jpeg', folder: f, registry: reg }), 'image_002.jpg');
  assert.equal(name({ serverName: 'cat.jpg', mime: 'image/jpeg', folder: f, registry: reg }), 'cat.jpg');
  assert.equal(name({ serverName: 'cat.jpg', mime: 'image/jpeg', folder: f, registry: reg }), 'cat (1).jpg');
  assert.equal(name({ serverName: 'CAT.jpg', mime: 'image/jpeg', folder: f, registry: reg }), 'CAT (2).jpg');
  // A different folder has its own namespace
  assert.equal(name({ serverName: 'cat.jpg', mime: 'image/jpeg', folder: 'ImageHunter/other', registry: reg }), 'cat.jpg');
});

test('different URLs with the same name are all kept', () => {
  const reg = new NameRegistry();
  const names = ['https://a.com/1/photo.jpg', 'https://b.com/2/photo.jpg', 'https://c.com/photo.jpg?v=2'].map(() => name({ serverName: 'photo.jpg', mime: 'image/jpeg', folder: 'F', registry: reg }));
  assert.deepEqual(names, ['photo.jpg', 'photo (1).jpg', 'photo (2).jpg']);
});

test('unknown names use page title + position', () => {
  const reg = new NameRegistry();
  assert.equal(fallbackBaseName('내 페이지: 1화?', 12), '내 페이지_ 1화__012');
  assert.equal(name({ serverName: 'download', mime: 'image/webp', fallbackBase: fallbackBaseName('갤러리', 3), folder: 'F', registry: reg }), '갤러리_003.webp');
  assert.equal(fallbackBaseName('', 3), '');
});

test('extension is marked as guessed unless the type was verified', () => {
  const reg = new NameRegistry();
  assert.deepEqual(decideFilename({ serverName: 'a.jpg', mime: 'image/jpeg', folder: 'F', registry: reg }), { name: 'a.jpg', extensionGuessed: false });
  assert.deepEqual(decideFilename({ serverName: 'b', mime: null, urlFormat: 'PNG', folder: 'F', registry: reg }), { name: 'b.png', extensionGuessed: true });
  assert.deepEqual(decideFilename({ serverName: 'c', mime: null, format: 'WEBP', folder: 'F', registry: reg }), { name: 'c.webp', extensionGuessed: false });
  assert.deepEqual(decideFilename({ serverName: '', mime: null, folder: 'F', registry: reg }), { name: 'image_001.jpg', extensionGuessed: true });
});

test('auto numbering skips names already taken', () => {
  const reg = new NameRegistry();
  reg.claim('F', 'image_001.jpg');
  assert.equal(reg.nextAuto('F', 'jpg'), 'image_002.jpg');
});

test('custom names win and get the right extension', () => {
  const reg = new NameRegistry();
  assert.equal(name({ customName: '표지', serverName: 'x.jpg', mime: 'image/png', folder: 'F', registry: reg }), '표지.png');
  assert.equal(name({ customName: '표지.png', mime: 'image/png', folder: 'F', registry: reg }), '표지 (1).png');
});

test('registry survives serialisation (service worker restarts)', () => {
  const reg = new NameRegistry();
  reg.nextAuto('F', 'jpg');
  reg.claim('F', 'a.jpg');
  const copy = new NameRegistry(JSON.parse(JSON.stringify(reg)));
  assert.equal(copy.nextAuto('F', 'jpg'), 'image_002.jpg');
  assert.equal(copy.claim('F', 'a.jpg'), 'a (1).jpg');
});

test('folders are relative to the download directory', () => {
  assert.equal(siteFolderName('https://www.example.com/a/b'), 'example.com');
  assert.equal(buildFolder({ rootFolder: 'ImageHunter', folderMode: 'page' }, { pageTitle: '페이지 제목: 1/2', url: 'https://a.com' }), 'ImageHunter/페이지 제목_ 1_2');
  assert.equal(buildFolder({ rootFolder: 'ImageHunter', folderMode: 'page' }, { pageTitle: '', url: 'https://www.a.com/x' }), 'ImageHunter/a.com');
  assert.equal(buildFolder({ rootFolder: 'ImageHunter', folderMode: 'site' }, { pageTitle: 'T', url: 'https://www.example.com/x' }), 'ImageHunter/example.com');
  assert.equal(buildFolder({ rootFolder: 'ImageHunter', folderMode: 'none' }, { pageTitle: 'T' }), 'ImageHunter');
  assert.equal(buildFolder({ rootFolder: 'ImageHunter', folderMode: 'none', subFolder: '../모음:집' }), 'ImageHunter/모음_집');
  // absolute paths / traversal can never come out
  assert.equal(buildFolder({ rootFolder: 'C:\\Windows', folderMode: 'page' }, { pageTitle: '..' }), 'C__Windows');
  assert.equal(buildFolder({ rootFolder: '/etc', folderMode: 'none' }), '_etc');
});

test('previewFilename ignores query strings and generic names', () => {
  assert.equal(previewFilename('https://a.com/p/photo.jpg?w=300&token=abc', 'JPEG'), 'photo.jpg');
  assert.equal(previewFilename('https://a.com/image.php?id=3', 'PNG'), null);
  assert.equal(previewFilename('https://a.com/media/abc123?format=jpg', 'JPEG'), 'abc123.jpg');
});

test('dots inside titles are not extensions', () => {
  assert.equal(sanitizeFilename('괴력 난신 - 116화. 조태청(1) : 네이버 웹툰'), '괴력 난신 - 116화. 조태청(1) _ 네이버 웹툰');
  assert.equal(sanitizeFilename('v1.2 release.PNG'), 'v1.2 release.png');
  const reg = new NameRegistry();
  const base = fallbackBaseName('괴력 난신 - 116화. 조태청(1) : 네이버 웹툰', 7);
  assert.equal(name({ serverName: '', mime: 'image/jpeg', fallbackBase: base, folder: 'F', registry: reg }), '괴력 난신 - 116화. 조태청(1) _ 네이버 웹툰_007.jpg');
});
