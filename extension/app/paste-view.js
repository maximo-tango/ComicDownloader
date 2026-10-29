// "URL 직접 입력" view: download a pasted list of image URLs without page analysis.
// Rows always stay in the order they were entered.

import { $, command, h, saveTextFile, STATUS_LABEL, timestamp, toast } from './common.js';
import { parseUrlList } from '../lib/paste.js';
import { buildFolder, previewFilename, sanitizeFilename } from '../lib/filename.js';
import { formatBytes } from '../lib/filters.js';
import { parseCsvLine } from '../lib/export.js';
import { aspectRatioText } from '../lib/url-utils.js';
import { createPdf, savePdf } from './pdf-export.js';

const pad = (n) => String(n).padStart(3, '0');

export function initPasteView({ getSettings, probe, enqueue }) {
  let rows = [];
  let jobs = new Map();
  const tbody = $('#pasteTable tbody');

  const folder = () => buildFolder({ ...getSettings(), folderMode: 'none', subFolder: $('#pasteFolder').value.trim() || '직접 입력' });

  function parse() {
    const { valid, invalid, duplicates } = parseUrlList($('#pasteText').value);
    $('#pasteSummary').textContent = `유효한 URL ${valid.length}개 · 중복 제거 ${duplicates}개 · 잘못된 URL ${invalid.length}개`;
    $('#pasteInvalid').replaceChildren(...invalid.map((x) => h('li', {}, `${x.line}번째 줄: ${x.reason} — ${x.text}`)));
    rows = valid.map((v, i) => ({ ...v, n: i + 1, state: 'checking', info: null, error: null, selected: true, jobId: null }));
    $('#pasteTable').hidden = !rows.length;
    $('#pasteActions').hidden = !rows.length;
    tbody.replaceChildren(...rows.map(buildRow));
    updateCount();
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
    row.el = h('tr');
    renderRow(row);
    return row.el;
  }

  function renderRow(row) {
    if (!row.el) return;
    const check = h('input', { type: 'checkbox', checked: row.selected, 'aria-label': `${row.n}번 선택`, onchange: (e) => { row.selected = e.target.checked; updateCount(); } });
    const preview = row.state === 'ok' ? h('img', { class: 'preview', src: row.url, loading: 'lazy', alt: '' }) : h('div', { class: 'preview' });
    let result;
    if (row.state === 'checking') result = h('span', { class: 'st downloading' }, '확인 중…');
    else if (row.state === 'ok') {
      const i = row.info;
      const parts = [
        i.width ? `${i.width}×${i.height} (${aspectRatioText(i.width, i.height)})` : '해상도 확인 불가',
        i.format ? (i.formatVerified ? i.format : `${i.format} (추정)`) : '형식 확인 불가',
        formatBytes(i.bytes) || '크기 확인 불가',
      ];
      result = h('span', { class: 'st ok' }, `✓ 불러올 수 있음 · ${parts.join(' · ')}`);
    } else if (row.state === 'page') {
      result = h('span', { class: 'st bad' }, '웹페이지 주소입니다 (이미지 아님). 그 페이지를 열고 Image Hunter 메뉴에서 "이 페이지의 이미지 찾기"를 누르세요.');
    } else result = h('span', { class: 'st bad', title: row.error || '' }, `✗ ${row.error || '확인 실패'}`);

    const nameInput = h('input', {
      class: 'name-input', type: 'text', value: row.customName, maxlength: '120',
      placeholder: previewFilename(row.url, row.info?.format) || `자동: image_${pad(row.n)}`,
      oninput: (e) => (row.customName = e.target.value),
    });
    row.jobTd = h('td', {}, jobCell(row));
    row.el.replaceChildren(
      h('td', { class: 'c-check' }, check),
      h('td', {}, String(row.n)),
      h('td', {}, preview),
      h('td', { class: 'url', title: row.url }, row.url),
      h('td', {}, result),
      h('td', {}, nameInput),
      row.jobTd,
    );
  }

  function jobCell(row) {
    const job = row.jobId != null ? jobs.get(row.jobId) : null;
    if (!job) return '';
    const pct = job.totalBytes ? Math.round((job.bytesReceived / job.totalBytes) * 100) : job.status === 'success' ? 100 : 0;
    return h('div', {},
      h('span', { class: `st ${job.status}` }, STATUS_LABEL[job.status] || job.status),
      job.status === 'downloading' ? h('div', { class: 'progress' }, h('div', { style: `width:${pct}%` })) : '',
      job.error ? h('div', { class: 'err st failed', style: 'font-weight:400' }, job.error) : '',
      job.status === 'failed' ? h('button', { class: 'btn small', onclick: () => command('retry', { ids: [job.id] }) }, '재시도') : '');
  }

  function updateCount() {
    const sel = rows.filter((r) => r.selected).length;
    const ok = rows.filter((r) => r.state === 'ok').length;
    $('#pasteCount').replaceChildren(`선택 ${sel} / ${rows.length}`, h('small', {}, ` · 확인됨 ${ok} · 실패 ${failedRows().length}`));
    $('#pasteCheckAll').checked = rows.length > 0 && sel === rows.length;
  }

  const failedRows = () => rows.filter((r) => r.state === 'bad' || jobs.get(r.jobId)?.status === 'failed');

  async function download(list) {
    list = list.filter((r) => r.state !== 'page');
    const already = list.filter((r) => ['success', 'pending', 'downloading'].includes(jobs.get(r.jobId)?.status));
    // Failed/cancelled before: retry that job instead of adding a duplicate.
    const again = list.filter((r) => ['failed', 'cancelled'].includes(jobs.get(r.jobId)?.status));
    if (again.length) await command('retry', { ids: again.map((r) => r.jobId) });
    list = list.filter((r) => !already.includes(r) && !again.includes(r));
    if (!list.length) {
      return toast(again.length ? `실패·취소했던 ${again.length}개를 다시 시도합니다.` : already.length ? '선택한 URL은 이미 받았거나 진행 중입니다.' : '다운로드할 URL이 없습니다.');
    }
    const { ids } = await enqueue(
      list.map((r) => ({
        url: r.url,
        source: 'paste',
        folder: folder(),
        customName: r.customName,
        fallbackBase: `image_${pad(r.n)}`,
        format: r.info?.format,
        formatVerified: r.info?.formatVerified,
        mime: r.info?.mime,
        serverName: r.info?.serverName,
        width: r.info?.width,
        height: r.info?.height,
        bytes: r.info?.bytes,
      })),
    );
    list.forEach((r, i) => (r.jobId = ids[i]));
    toast(`${list.length}개를 입력 순서대로 다운로드 대기열에 추가했습니다.${already.length ? ` (이미 받은 ${already.length}개 제외)` : ''}`);
  }

  const setAll = (on) => {
    rows.forEach((r) => (r.selected = on && r.state !== 'page'));
    rows.forEach(renderRow);
    updateCount();
  };

  $('#btnPasteParse').addEventListener('click', parse);
  $('#pasteSelectAll').addEventListener('click', () => setAll(true));
  $('#pasteSelectNone').addEventListener('click', () => setAll(false));
  $('#pasteCheckAll').addEventListener('change', (e) => setAll(e.target.checked));
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

  const root = () => getSettings().rootFolder || 'ImageHunter';
  $('#pasteExportFailed').addEventListener('click', async () => {
    const failed = failedRows();
    if (!failed.length) return toast('실패한 항목이 없습니다.');
    const text = failed.map((r) => `# ${jobs.get(r.jobId)?.error || r.error || '실패'}\n${r.url}`).join('\n') + '\n';
    await navigator.clipboard.writeText(text).catch(() => {});
    await saveTextFile(`${root()}/failed_urls_${timestamp()}.txt`, text);
    toast(`실패 목록 ${failed.length}개를 파일로 저장하고 클립보드에 복사했습니다.`);
  });
  $('#pasteExportTxt').addEventListener('click', async () => {
    if (!rows.length) return toast('내보낼 목록이 없습니다.');
    await saveTextFile(`${root()}/url_list_${timestamp()}.txt`, rows.map((r) => (r.customName ? `${r.url}  ${r.customName}` : r.url)).join('\n') + '\n', { bom: false });
    toast('URL 목록을 TXT로 저장했습니다.');
  });
  $('#pasteExportCsv').addEventListener('click', async () => {
    if (!rows.length) return toast('내보낼 목록이 없습니다.');
    const q = (s) => {
      let v = String(s ?? '');
      if (/^[=+\-@]/.test(v)) v = "'" + v;
      return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
    };
    const csv = '﻿url,filename\r\n' + rows.map((r) => `${q(r.url)},${q(r.customName)}`).join('\r\n') + '\r\n';
    await saveTextFile(`${root()}/url_list_${timestamp()}.csv`, csv, { bom: false });
    toast('URL 목록을 CSV로 저장했습니다.');
  });

  // TXT: one URL per line (optionally followed by a name). CSV: url[,filename], header optional.
  $('#pasteImport').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) return toast('5MB보다 큰 파일은 불러올 수 없습니다.');
    let text = (await file.text()).replace(/^﻿/, '');
    if (/\.csv$/i.test(file.name) || file.type === 'text/csv') {
      text = text
        .split(/\r?\n/)
        .map(parseCsvLine)
        .filter((cols) => cols[0] && !/^url$/i.test(cols[0]))
        .map(([url, name]) => (name ? `${url}  ${name}` : url))
        .join('\n');
    }
    const box = $('#pasteText');
    box.value = box.value.trim() ? `${box.value.trimEnd()}\n${text}` : text;
    parse();
    toast(`${file.name}에서 URL 목록을 불러왔습니다.`);
  });

  $('#pastePdf').addEventListener('click', async () => {
    const list = rows.filter((r) => r.selected && r.state !== 'page');
    if (!list.length) return toast('PDF에 넣을 URL을 선택하세요.');
    const btn = $('#pastePdf');
    btn.disabled = true;
    try {
      const title = $('#pasteFolder').value.trim() || `images_${timestamp()}`;
      const result = await createPdf(list.map((r) => ({ url: r.url, label: `${r.n}번` })), {
        title,
        pageSize: getSettings().pdfPageSize,
        onProgress: (i, n) => (btn.textContent = `PDF 만드는 중 ${i}/${n}`),
      });
      if (!result.blob) {
        const msg = `PDF를 만들지 못했습니다: ${result.skipped[0]?.reason || '넣을 수 있는 이미지가 없음'}`;
        $('#pasteSummary').textContent = msg;
        toast(msg, 5000);
        return;
      }
      const filename = `${folder()}/${sanitizeFilename(title)}.pdf`;
      await savePdf(result.blob, filename);
      const skipped = result.skipped.map((s) => `${s.label}(${s.reason})`).join(', ');
      const msg = `PDF 저장: ${result.included}장 → ${filename}${skipped ? ` · 제외: ${skipped}` : ''}`;
      $('#pasteSummary').textContent = msg;
      toast(msg, 6000);
    } catch (e) {
      $('#pasteSummary').textContent = `PDF를 만들지 못했습니다: ${e?.message || e}`;
    } finally {
      btn.disabled = false;
      btn.textContent = 'PDF로 저장';
    }
  });

  return {
    onJobs(list) {
      jobs = new Map(list.map((j) => [j.id, j]));
      for (const r of rows) if (r.jobId != null && r.jobTd) r.jobTd.replaceChildren(jobCell(r));
      if (rows.length) updateCount();
    },
  };
}
