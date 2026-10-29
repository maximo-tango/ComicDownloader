import { DEFAULT_SETTINGS, loadSettings, saveSettings } from '../lib/settings.js';

const form = document.querySelector('#form');
const ALL = { origins: ['<all_urls>'] };

function fill(s) {
  for (const [k, v] of Object.entries(s)) {
    const el = form.elements[k];
    if (!el) continue;
    if (el.type === 'checkbox') el.checked = !!v;
    else el.value = v;
  }
}

const clamp = (v, min, max, dflt) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : dflt;
};

form.addEventListener('change', async () => {
  const f = form.elements;
  const s = await saveSettings({
    rootFolder: f.rootFolder.value.trim() || DEFAULT_SETTINGS.rootFolder,
    folderMode: f.folderMode.value,
    conflictAction: f.conflictAction.value,
    concurrency: clamp(f.concurrency.value, 1, 8, 3),
    pdfPageSize: f.pdfPageSize.value,
    previewSize: f.previewSize.value,
    thumbMaxSide: clamp(f.thumbMaxSide.value, 16, 4000, 300),
    scrollMaxScreens: clamp(f.scrollMaxScreens.value, 1, 200, 30),
    guessVariants: f.guessVariants.checked,
  });
  fill(s);
  document.querySelector('#saved').textContent = '저장되었습니다. 원본 판별 설정은 다음 검색부터 적용됩니다.';
});

async function showPermission() {
  const has = await chrome.permissions.contains(ALL);
  document.querySelector('#permState').textContent = has ? '현재 상태: 모든 사이트 접근 허용됨' : '현재 상태: 메뉴를 연 탭에만 접근 (기본)';
  document.querySelector('#grant').disabled = has;
  document.querySelector('#revoke').disabled = !has;
}
document.querySelector('#grant').addEventListener('click', async () => {
  await chrome.permissions.request(ALL).catch(() => false);
  showPermission();
});
document.querySelector('#revoke').addEventListener('click', async () => {
  await chrome.permissions.remove(ALL).catch(() => false);
  showPermission();
});

fill(await loadSettings());
showPermission();
