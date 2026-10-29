import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync, inflateSync } from 'node:zlib';
import { parseCsvLine, resultRows, toCsv, toJson } from '../extension/lib/export.js';
import { buildPdf, pageLayout, planPages } from '../extension/lib/pdf.js';
import { jpegDetails } from '../extension/lib/image-header.js';
import { jpegHeader } from './helpers.js';

const jobs = [
  { id: 1, url: 'https://a.com/x.jpg', sourceUrl: 'https://a.com/x_thumb.jpg', filename: 'ImageHunter/T/x.jpg', width: 800, height: 600, status: 'success', source: 'page', startedAt: 0, finishedAt: 1700000000000 },
  { id: 2, url: 'https://a.com/y', filename: 'ImageHunter/T/y.png', extensionGuessed: true, status: 'failed', error: '접근 거부 (403), "외부"', source: 'paste' },
  { id: 3, url: 'https://a.com/=cmd', filename: '', status: 'pending', source: 'page' },
];

test('CSV export: BOM, Korean headers, quoting, formula injection guard', () => {
  const csv = toCsv(resultRows(jobs));
  assert.ok(csv.startsWith('﻿원본 URL,다운로드 URL,파일명,너비,높이,확장자,확장자 추정,상태,오류,출처,시작 시각,완료 시각\r\n'));
  const lines = csv.slice(1).trim().split('\r\n');
  assert.equal(lines.length, 4);
  assert.match(lines[1], /^https:\/\/a\.com\/x_thumb\.jpg,https:\/\/a\.com\/x\.jpg,ImageHunter\/T\/x\.jpg,800,600,jpg,no,완료,,페이지 추출,,2023-/);
  assert.match(lines[2], /"접근 거부 \(403\), ""외부"""/);
  assert.match(lines[2], /,png,yes,실패,/);
  assert.match(lines[2], /URL 직접 입력/);
  assert.deepEqual(parseCsvLine('"a,b","c ""d""",e'), ['a,b', 'c "d"', 'e']);
});

test('JSON export keeps every field', () => {
  const data = JSON.parse(toJson(resultRows(jobs)));
  assert.equal(data.length, 3);
  assert.deepEqual(Object.keys(data[0]).sort(), ['downloadUrl', 'error', 'extension', 'extensionGuessed', 'filename', 'finishedAt', 'height', 'source', 'sourceUrl', 'startedAt', 'status', 'width'].sort());
  assert.equal(data[1].status, 'failed');
});

/** Tiny PDF reader for tests: checks the xref table and extracts image objects. */
function readPdf(bytes) {
  const text = Buffer.from(bytes).toString('latin1');
  assert.ok(text.startsWith('%PDF-1.4\n'));
  assert.ok(text.trimEnd().endsWith('%%EOF'));
  const startxref = Number(/startxref\n(\d+)\n%%EOF/.exec(text)[1]);
  assert.equal(text.slice(startxref, startxref + 4), 'xref');
  const [, first, count] = /xref\n(\d+) (\d+)\n/.exec(text.slice(startxref));
  const entries = text.slice(startxref).split('\n').slice(2, 2 + Number(count));
  entries.slice(1).forEach((e, i) => {
    const off = Number(e.slice(0, 10));
    assert.equal(text.slice(off, off + `${i + 1} 0 obj`.length), `${i + 1} 0 obj`, `xref offset of object ${i + 1}`);
  });
  const images = [...text.matchAll(/\/Subtype \/Image \/Width (\d+) \/Height (\d+) \/ColorSpace \/(\w+) \/BitsPerComponent 8 \/Filter \/(\w+) \/Length (\d+) >>\nstream\n/g)].map((m) => ({
    width: +m[1], height: +m[2], cs: m[3], filter: m[4], data: bytes.subarray(m.index + m[0].length, m.index + m[0].length + Number(m[5])),
  }));
  return { text, images, pages: (text.match(/\/Type \/Page /g) || []).length, first: Number(first) };
}

test('PDF: pages in the given order, JPEG passed through, others lossless', () => {
  const jpeg = jpegHeader(640, 480);
  const rgb = new Uint8Array(3 * 2 * 3).fill(200);
  const chunks = buildPdf(
    [
      { kind: 'jpeg', data: jpeg, width: 640, height: 480, components: 3 },
      { kind: 'flate', data: deflateSync(rgb), width: 3, height: 2 },
    ],
    { title: '웹툰 1화', layout: 'page' },
  );
  const bytes = Buffer.concat(chunks.map((c) => Buffer.from(c)));
  const pdf = readPdf(bytes);
  assert.equal(pdf.pages, 2);
  assert.match(pdf.text, /\/Count 2/);
  assert.deepEqual(pdf.images.map((i) => [i.width, i.height, i.filter]), [[640, 480, 'DCTDecode'], [3, 2, 'FlateDecode']]);
  assert.deepEqual(Buffer.from(pdf.images[0].data), Buffer.from(jpeg), 'JPEG bytes unchanged');
  assert.deepEqual(new Uint8Array(inflateSync(pdf.images[1].data)), rgb, 'pixels unchanged');
  // UTF-16 title
  assert.match(pdf.text, /\/Title <feffc6f9/); // "웹" = U+C6F9, UTF-16BE with BOM
});

test('PDF page layout (one image per page)', () => {
  assert.deepEqual(pageLayout(800, 600, 'image'), [800, 600, 0, 0, 800, 600]);
  const [pw, ph] = pageLayout(800, 40000, 'image'); // long webtoon strip: scaled to the 14400pt limit
  assert.equal(ph, 14400);
  assert.ok(Math.abs(pw - 288) < 0.01);
  const a4 = pageLayout(1000, 2000, 'a4');
  assert.deepEqual(a4.slice(0, 2), [595.28, 841.89]);
  const land = pageLayout(2000, 1000, 'a4');
  assert.deepEqual(land.slice(0, 2), [841.89, 595.28]);
});

test('continuous layout: images joined with no gap, pages break only between images', () => {
  const strip = { width: 690, height: 1600 };
  const pages = planPages(Array(20).fill(strip), 'continuous');
  // 14400 / 1600 = 9 strips per page → 9 + 9 + 2
  assert.deepEqual(pages.map((p) => p.items.length), [9, 9, 2]);
  assert.deepEqual(pages.map((p) => p.height), [14400, 14400, 3200]);
  for (const p of pages) {
    assert.equal(p.width, 690);
    p.items.forEach((it, k) => assert.equal(it.y, k * 1600, 'no gap between images'));
  }
  assert.deepEqual(pages.flatMap((p) => p.items.map((i) => i.index)), [...Array(20).keys()], 'page order kept');
});

test('continuous layout: narrower images are centred, too-tall ones get their own page', () => {
  const pages = planPages([{ width: 690, height: 1000 }, { width: 300, height: 100 }, { width: 690, height: 30000 }, { width: 690, height: 500 }], 'continuous');
  assert.deepEqual(pages.map((p) => p.items.map((i) => i.index)), [[0, 1], [2], [3]]);
  assert.equal(pages[0].items[1].x, 195);
  assert.equal(pages[1].height, 14400);
  assert.ok(pages[1].items[0].w < 690);
});

test('continuous PDF: one page, images stacked top-down with seam overlap', () => {
  const jpeg = jpegHeader(100, 50);
  const bytes = Buffer.concat(buildPdf([
    { kind: 'jpeg', data: jpeg, width: 100, height: 50, components: 3 },
    { kind: 'jpeg', data: jpeg, width: 100, height: 50, components: 3 },
  ], { layout: 'continuous' }).map((c) => Buffer.from(c)));
  const pdf = readPdf(bytes);
  assert.equal(pdf.pages, 1);
  assert.match(pdf.text, /\/MediaBox \[0 0 100 100\]/);
  assert.match(pdf.text, /q 100 0 0 50.5 0 49.5 cm \/Im0 Do Q\nq 100 0 0 50 0 0 cm \/Im1 Do Q/);
});

test('jpegDetails reports stored size, components and orientation', () => {
  assert.deepEqual(jpegDetails(jpegHeader(400, 300, { orientation: 6 })), { width: 400, height: 300, components: 3, orientation: 6, adobe: false, progressive: false });
  assert.equal(jpegDetails(new Uint8Array([1, 2, 3])), null);
});
