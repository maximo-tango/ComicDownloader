import { h } from './common.js';
import { formatBytes } from '../lib/filters.js';
import { previewFilename } from '../lib/filename.js';
import { SOURCE_LABEL } from '../lib/resolver.js';

export function dimsText(item) {
  const parts = [item.width ? `${item.width} × ${item.height}` : '해상도 미확인'];
  parts.push(item.format || '형식 미확인');
  const size = formatBytes(item.bytes);
  if (size) parts.push(size); // unverified sizes are never shown
  return parts.join(' · ');
}

export function displayName(item) {
  return previewFilename(item.originalUrl, item.format) || '자동 생성 파일명 (image_###)';
}

const ORIGINAL_STATUS = {
  found: ['원본 발견', 'good', '표시된 이미지보다 큰 원본을 찾아 확인했습니다'],
  self: ['표시 이미지 = 원본 후보', 'mid', '더 큰 버전을 찾지 못했습니다. 표시 중인 이미지가 가장 큰 후보입니다'],
  none: ['원본 후보 없음', 'bad', '해상도를 확인할 수 있는 후보가 없습니다'],
};

export function badges(item) {
  if (item.pending) return [h('span', { class: 'badge' }, '판별 중…')];
  const conf = item.confidenceLabel;
  const out = [
    h('span', { class: `badge ${conf === '높음' ? 'good' : conf === '보통' ? 'mid' : 'warn'}`, title: `원본 신뢰도 ${Math.round(item.originalConfidence * 100)}%` }, `원본 ${conf}`),
  ];
  const [label, cls, tip] = ORIGINAL_STATUS[item.originalStatus] || ORIGINAL_STATUS.none;
  if (item.originalStatus !== 'self') out.push(h('span', { class: `badge ${cls}`, title: tip }, label));
  out.push(h('span', { class: 'badge', title: '원본 URL을 찾은 위치' }, SOURCE_LABEL[item.sourceType] || item.sourceType));
  if (item.isThumbnail) out.push(h('span', { class: 'badge warn' }, '썸네일 의심'));
  return out;
}

export function statusBadge(item) {
  const [label, cls, tip] = ORIGINAL_STATUS[item.originalStatus] || ORIGINAL_STATUS.none;
  return { label, cls, tip };
}
