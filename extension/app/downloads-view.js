// "다운로드" view: job list, progress, retry/cancel and result export.

import { $, command, h, saveTextFile, STATUS_LABEL, timestamp, toast } from './common.js';
import { formatBytes } from '../lib/filters.js';
import { resultRows, toCsv, toJson } from '../lib/export.js';

export function initDownloadsView({ getSettings, onJobs }) {
  let jobs = [];
  const rows = new Map();
  // The service worker can be stopped by Chrome at any time; reconnect so
  // progress keeps flowing (the worker restores its queue on start).
  const connect = () => {
    const port = chrome.runtime.connect({ name: 'ih-downloads' });
    port.onMessage.addListener((msg) => {
      if (msg.type !== 'downloads') return;
      jobs = msg.jobs;
      render();
      onJobs(jobs);
    });
    port.onDisconnect.addListener(() => setTimeout(connect, 500));
  };
  connect();

  function render() {
    const counts = {};
    for (const j of jobs) counts[j.status] = (counts[j.status] || 0) + 1;
    const active = (counts.pending || 0) + (counts.downloading || 0);
    const badge = $('#dlBadge');
    badge.hidden = !active && !counts.failed;
    badge.textContent = active || counts.failed || '';
    badge.style.background = !active && counts.failed ? 'var(--bad)' : '';
    $('#dlSummary').textContent = jobs.length
      ? `전체 ${jobs.length} · ` + ['pending', 'downloading', 'success', 'failed', 'cancelled'].map((s) => `${STATUS_LABEL[s]} ${counts[s] || 0}`).join(' · ')
      : '';
    $('#dlEmpty').hidden = jobs.length > 0;
    $('#dlTable').hidden = !jobs.length;

    const live = new Set();
    const trs = [...jobs].reverse().map((j) => {
      live.add(j.id);
      let r = rows.get(j.id);
      if (!r) {
        r = { tr: h('tr', { dataset: { job: j.id } }), sig: '' };
        rows.set(j.id, r);
      }
      const sig = [j.status, j.bytesReceived, j.totalBytes, j.filename, j.error, j.extensionGuessed].join('|');
      if (sig !== r.sig) {
        r.sig = sig;
        r.tr.replaceChildren(...cells(j));
      }
      return r.tr;
    });
    for (const id of rows.keys()) if (!live.has(id)) rows.delete(id);
    $('#dlTable tbody').replaceChildren(...trs);
  }

  function cells(j) {
    const name = j.filename ? j.filename.split('/').slice(1).join('/') : j.customName || '(파일명 결정 전)';
    // Progress only from what Chrome reports; no total means no percentage.
    const pct = j.status === 'success' ? 100 : j.totalBytes ? Math.min(100, Math.round((j.bytesReceived / j.totalBytes) * 100)) : null;
    const bytes = j.totalBytes ? `${formatBytes(j.bytesReceived)} / ${formatBytes(j.totalBytes)}` : j.bytesReceived ? formatBytes(j.bytesReceived) : '';
    const actions = [];
    if (j.status === 'failed' || j.status === 'cancelled') actions.push(h('button', { class: 'btn small', onclick: () => command('retry', { ids: [j.id] }) }, '재시도'));
    if (j.status === 'pending' || j.status === 'downloading') actions.push(h('button', { class: 'btn small', onclick: () => command('cancel', { ids: [j.id] }) }, '취소'));
    return [
      h('td', {}, String(j.id)),
      h('td', { class: 'url', title: `${j.url}\n→ ${j.savedPath || j.filename || ''}` },
        h('div', {}, name + (j.extensionGuessed ? ' (확장자 추정)' : '')),
        h('div', { class: 'pbytes' }, j.url.startsWith('data:') ? '(data URL)' : j.url)),
      h('td', {}, j.source === 'paste' ? 'URL 직접 입력' : '페이지 추출'),
      h('td', {}, h('span', { class: `st ${j.status}` }, STATUS_LABEL[j.status] || j.status)),
      h('td', { class: 'c-progress' },
        h('div', { class: `progress ${j.status === 'success' ? 'done' : j.status === 'failed' ? 'failed' : ''}` }, h('div', { style: `width:${pct ?? 0}%` })),
        h('div', { class: 'pbytes' }, [pct != null ? `${pct}%` : j.status === 'downloading' ? '진행률 확인 불가' : '', bytes].filter(Boolean).join(' · '))),
      h('td', { class: 'err' }, j.error || ''),
      h('td', {}, ...actions),
    ];
  }

  const root = () => getSettings().rootFolder || 'ImageHunter';
  $('#dlRetryFailed').addEventListener('click', () => command('retry', {}));
  $('#dlCancelAll').addEventListener('click', () => command('cancel', {}));
  $('#dlClear').addEventListener('click', () => command('clear', { statuses: ['success', 'cancelled'] }));
  $('#dlOpenFolder').addEventListener('click', () => chrome.downloads.showDefaultFolder());
  $('#dlExportCsv').addEventListener('click', async () => {
    if (!jobs.length) return toast('내보낼 다운로드 결과가 없습니다.');
    await saveTextFile(`${root()}/download_result_${timestamp()}.csv`, toCsv(resultRows(jobs)), { bom: false });
    toast(`다운로드 결과 ${jobs.length}건을 CSV로 저장했습니다.`);
  });
  $('#dlExportJson').addEventListener('click', async () => {
    if (!jobs.length) return toast('내보낼 다운로드 결과가 없습니다.');
    await saveTextFile(`${root()}/download_result_${timestamp()}.json`, toJson(resultRows(jobs)), { bom: false });
    toast(`다운로드 결과 ${jobs.length}건을 JSON으로 저장했습니다.`);
  });
  $('#dlExportFailed').addEventListener('click', async () => {
    const failed = jobs.filter((j) => j.status === 'failed');
    if (!failed.length) return toast('실패한 다운로드가 없습니다.');
    const text = failed.map((j) => `# ${j.error || '실패'}\n${j.url}`).join('\n') + '\n';
    await navigator.clipboard.writeText(text).catch(() => {});
    await saveTextFile(`${root()}/failed_urls_${timestamp()}.txt`, text);
    toast(`실패 URL ${failed.length}개를 저장하고 클립보드에 복사했습니다. "URL 직접 입력"에 붙여넣어 다시 받을 수 있습니다.`, 4000);
  });
}
