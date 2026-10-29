// "URL 붙여넣기" view: download a pasted list of image URLs without page analysis.

import { $, command, h, saveTextFile, STATUS_LABEL, timestamp, toast } from './common.js';
import { parseUrlList } from '../lib/paste.js';
import { buildFolder, previewFilename } from '../lib/filename.js';
import { formatBytes } from '../lib/filters.js';
import { hostOf } from '../lib/url-utils.js';

export function initPasteView({ getSettings, probe, enqueue, analyzeUrl }) {
  let rows = [];
  let jobs = new Map();
  const tbody = $('#pasteTable tbody');

  const refererFor = (url) => {
    const manual = $('#pasteReferer').value.trim();
    if (manual) return manual;
    try {
      return new URL(url).origin + '/';
    } catch {
      return '';
    }
  };

  async function parse() {
    const { valid, invalid, duplicates } = parseUrlList($('#pasteText').value);
    $('#pasteSummary').textContent = `유효한 URL ${valid.length}개 · 중복 제거 ${duplicates}개 · 형식 오류 ${invalid.length}개`;
    $('#pasteInvalid').replaceChildren(...invalid.map((x) => h('li', {}, `${x.line}번째 줄: ${x.reason} — ${x.text}`)));
    rows = valid.map((v) => ({ ...v, state: 'checking', info: null, error: null, selected: true, jobId: null, el: null }));
    $('#pasteTable').hidden = !rows.length;
    $('#pasteActions').hidden = !rows.length;
    tbody.replaceChildren(...rows.map(buildRow));
    updateCount();
    if (getSettings().setReferer) {
      const pairs = [...new Map(rows.map((r) => [hostOf(r.url), { host: hostOf(r.url), referer: refererFor(r.url) }])).values()];
      await command('setReferers', { scope: 'tab', pairs }).catch(() => {});
    }
    rows.forEach(check);
  }

  async function check(row) {
    row.state = 'checking';
    renderRow(row);
    const r = await probe(row.url);
    if (r.ok) {
      row.state = 'ok';
      row.info = r;
    } else {
      row.state = r.isPage ? 'page' : 'bad';
      row.error = r.error;
      if (r.isPage) row.selected = false;
    }
    renderRow(row);
    updateCount();
  }

  function buildRow(row) {
    const tr = h('tr');
    row.el = tr;
    renderRow(row);
    return tr;
  }

  function renderRow(row) {
    const tr = row.el;
    if (!tr) return;
    const check = h('input', { type: 'checkbox', checked: row.selected, onchange: (e) => { row.selected = e.target.checked; updateCount(); } });
    const preview = row.state === 'ok' ? h('img', { class: 'preview', src: row.url, loading: 'lazy', alt: '' }) : h('div', { class: 'preview' });
    let result;
    if (row.state === 'checking') result = h('span', { class: 'st checking' }, '확인 중…');
    else if (row.state === 'ok') {
      const i = row.info;
      const parts = [i.width ? `${i.width}×${i.height}` : '해상도 미확인', i.format || '형식 미확인', formatBytes(i.bytes)].filter(Boolean);
      result = h('span', { class: 'st ok' }, `✓ 다운로드 가능 · ${parts.join(' · ')}`);
    } else if (row.state === 'page') {
      result = h('span', {}, h('span', { class: 'st bad' }, '웹페이지 주소입니다 (이미지 아님) '),
        h('button', { class: 'btn small', onclick: () => analyzeUrl(row.url) }, '이 페이지 분석'));
    } else result = h('span', { class: 'st bad', title: row.error || '' }, `✗ ${row.error || '확인 실패'}`);

    const nameInput = h('input', {
      class: 'name-input', type: 'text', value: row.customName,
      placeholder: previewFilename(row.url, row.info?.format) || '자동 생성 (image_###)',
      oninput: (e) => (row.customName = e.target.value),
    });

    tr.replaceChildren(
      h('td', { class: 'c-check' }, check),
      h('td', {}, preview),
      h('td', { class: 'url', title: row.url }, row.url),
      h('td', {}, result),
      h('td', {}, nameInput),
      (row.jobTd = h('td', {}, jobCell(row))),
    );
  }

  function jobCell(row) {
    const job = row.jobId != null ? jobs.get(row.jobId) : null;
    if (!job) return '';
    const pct = job.totalBytes ? Math.round((job.bytesReceived / job.totalBytes) * 100) : job.status === 'complete' ? 100 : 0;
    return h('div', {},
      h('span', { class: `st ${job.status}` }, STATUS_LABEL[job.status] || job.status),
      job.status === 'in_progress' ? h('div', { class: 'progress' }, h('div', { style: `width:${pct}%` })) : '',
      job.error ? h('div', { class: 'err st failed', style: 'font-weight:400' }, job.error) : '',
      job.status === 'failed' ? h('button', { class: 'btn small', onclick: () => command('retry', { ids: [job.id] }) }, '재시도') : '');
  }

  function updateCount() {
    const sel = rows.filter((r) => r.selected).length;
    const ok = rows.filter((r) => r.state === 'ok').length;
    const bad = failedRows().length;
    $('#pasteCount').replaceChildren(`선택 ${sel} / ${rows.length}`, h('small', {}, ` · 확인됨 ${ok} · 실패 ${bad}`));
    $('#pasteCheckAll').checked = rows.length > 0 && sel === rows.length;
  }

  function failedRows() {
    return rows.filter((r) => r.state === 'bad' || jobs.get(r.jobId)?.status === 'failed');
  }

  async function download(list) {
    list = list.filter((r) => r.state !== 'page');
    if (!list.length) return toast('다운로드할 URL이 없습니다.');
    const s = getSettings();
    const sub = $('#pasteFolder').value.trim();
    const { ids } = await enqueue(
      list.map((r) => ({
        url: r.url,
        referer: s.setReferer ? refererFor(r.url) : '',
        folder: buildFolder({ ...s, subFolder: sub }, r.url),
        customName: r.customName,
        format: r.info?.format,
        bytes: r.info?.bytes,
        group: 'paste',
      })),
    );
    list.forEach((r, i) => (r.jobId = ids[i]));
    toast(`${list.length}개 다운로드를 대기열에 추가했습니다.`);
  }

  $('#btnPasteParse').addEventListener('click', parse);
  $('#pasteSelectAll').addEventListener('click', () => { rows.forEach((r) => (r.selected = true)); rows.forEach(renderRow); updateCount(); });
  $('#pasteSelectNone').addEventListener('click', () => { rows.forEach((r) => (r.selected = false)); rows.forEach(renderRow); updateCount(); });
  $('#pasteCheckAll').addEventListener('change', (e) => { rows.forEach((r) => (r.selected = e.target.checked)); rows.forEach(renderRow); updateCount(); });
  $('#pasteDlAll').addEventListener('click', () => download(rows));
  $('#pasteDlSel').addEventListener('click', () => download(rows.filter((r) => r.selected)));
  $('#pasteRetry').addEventListener('click', async () => {
    const failed = failedRows();
    if (!failed.length) return toast('실패한 항목이 없습니다.');
    const jobIds = failed.map((r) => jobs.get(r.jobId)).filter((j) => j?.status === 'failed').map((j) => j.id);
    if (jobIds.length) await command('retry', { ids: jobIds });
    for (const r of failed.filter((x) => x.state === 'bad')) {
      probe.forget(r.url);
      check(r);
    }
    toast(`${failed.length}개 항목을 다시 시도합니다.`);
  });
  $('#pasteExport').addEventListener('click', async () => {
    const failed = failedRows();
    if (!failed.length) return toast('실패한 항목이 없습니다.');
    const text = failed.map((r) => `# ${jobs.get(r.jobId)?.error || r.error || '실패'}\n${r.url}`).join('\n') + '\n';
    await navigator.clipboard.writeText(text).catch(() => {});
    await saveTextFile(`${getSettings().rootFolder || 'Image Hunter'}/failed_urls_${timestamp()}.txt`, text);
    toast(`실패 목록 ${failed.length}개를 파일로 저장하고 클립보드에 복사했습니다.`);
  });

  return {
    onDownloads(list) {
      jobs = new Map(list.map((j) => [j.id, j]));
      for (const r of rows) if (r.jobId != null && r.jobTd) r.jobTd.replaceChildren(jobCell(r));
      if (rows.length) updateCount();
    },
  };
}
