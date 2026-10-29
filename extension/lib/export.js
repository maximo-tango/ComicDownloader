// Download result export (CSV / JSON).

export const RESULT_COLUMNS = [
  ['sourceUrl', '원본 URL'],
  ['downloadUrl', '다운로드 URL'],
  ['filename', '파일명'],
  ['width', '너비'],
  ['height', '높이'],
  ['extension', '확장자'],
  ['extensionGuessed', '확장자 추정'],
  ['status', '상태'],
  ['error', '오류'],
  ['source', '출처'],
  ['startedAt', '시작 시각'],
  ['finishedAt', '완료 시각'],
];

const STATUS_TEXT = { pending: '대기', downloading: '진행 중', success: '완료', failed: '실패', cancelled: '취소' };

const iso = (t) => (t ? new Date(t).toISOString() : '');

/** Flattens download jobs into export rows. */
export function resultRows(jobs) {
  return jobs.map((j) => {
    const filename = (j.filename || '').split('/').pop();
    const ext = filename.includes('.') ? filename.split('.').pop() : '';
    return {
      sourceUrl: j.sourceUrl || j.url,
      downloadUrl: j.url,
      filename: j.filename || '',
      width: j.width || '',
      height: j.height || '',
      extension: ext,
      extensionGuessed: j.extensionGuessed ? 'yes' : 'no',
      status: j.status,
      statusText: STATUS_TEXT[j.status] || j.status,
      error: j.error || '',
      source: j.source === 'paste' ? 'URL 직접 입력' : '페이지 추출',
      startedAt: iso(j.startedAt),
      finishedAt: iso(j.finishedAt),
    };
  });
}

function csvCell(v) {
  let s = String(v ?? '');
  // Spreadsheet formula injection: page-supplied text must not start a formula.
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(rows, columns = RESULT_COLUMNS) {
  const head = columns.map(([, label]) => csvCell(label)).join(',');
  const body = rows.map((r) => columns.map(([k]) => csvCell(k === 'status' ? r.statusText ?? r.status : r[k])).join(','));
  // BOM so Excel on Windows reads UTF-8 Korean correctly.
  return '﻿' + [head, ...body].join('\r\n') + '\r\n';
}

export function toJson(rows) {
  return JSON.stringify(
    rows.map(({ statusText, ...r }) => r),
    null,
    2,
  );
}

/** Parses a URL list from CSV/TXT: first column = URL, optional second column = file name. */
export function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}
