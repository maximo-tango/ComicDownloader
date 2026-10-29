import { h } from './common.js';
import { formatBytes } from '../lib/filters.js';
import { previewFilename, extForFormat } from '../lib/filename.js';
import { ORIGINAL_STATE, SOURCE_LABEL } from '../lib/resolver.js';
import { aspectRatioText } from '../lib/url-utils.js';
import { STATUS_LABEL } from './common.js';

export const STATE_CLASS = { confirmed: 'good', hires: 'mid', compare: 'warn', unknown: 'bad' };

/** "1920 × 1280 · 3:2" — or an explicit "확인 불가", never an estimate. */
export function dimsText(item) {
  if (item.urlError) return '다운로드 불가';
  if (item.pending) return '확인 중…';
  if (!item.width) return '해상도 확인 불가';
  return `${item.width} × ${item.height} · ${aspectRatioText(item.width, item.height)}`;
}

export function extText(item) {
  const ext = extForFormat(item.format);
  if (!ext) return '확장자 확인 불가';
  return item.formatVerified ? ext.toUpperCase() : `${ext.toUpperCase()} (추정)`;
}

export function sizeText(item) {
  return formatBytes(item.bytes) || '크기 확인 불가';
}

export function displayName(item) {
  if (item.urlError) return item.displayUrl || '(빈 URL)';
  return previewFilename(item.originalUrl, item.format) || '자동 파일명 (페이지 제목_순번)';
}

export function badges(item, job) {
  const out = [];
  if (item.urlError) {
    out.push(h('span', { class: 'badge bad', title: item.urlError }, item.urlKind === 'blob' ? 'blob URL' : '잘못된 URL'));
  } else if (item.pending) {
    out.push(h('span', { class: 'badge' }, '판별 중…'));
  } else {
    const st = item.originalState || 'unknown';
    out.push(h('span', { class: `badge ${STATE_CLASS[st]}`, title: `원본 신뢰도 ${Math.round((item.originalConfidence || 0) * 100)}%` }, ORIGINAL_STATE[st] + (item.userChosen ? ' (직접 선택)' : '')));
    out.push(h('span', { class: 'badge', title: '다운로드 URL을 찾은 위치' }, SOURCE_LABEL[item.sourceType] || item.sourceType));
    if (item.isThumbnail) out.push(h('span', { class: 'badge warn' }, '썸네일 의심'));
  }
  if (item.inPage === false) out.push(h('span', { class: 'badge', title: '마지막 검색에서 페이지에 없던 항목' }, '페이지에서 사라짐'));
  if (job) out.push(h('span', { class: `badge dl-${job.status}`, title: job.error || job.filename || '' }, `다운로드 ${STATUS_LABEL[job.status]}`));
  return out;
}
