import { DEFAULT_SETTINGS, loadSettings, saveSettings } from '../lib/settings.js';

const form = document.querySelector('#form');
const ALL = { origins: ['<all_urls>'] };

function fill(s) {
  form.elements.jpgOnly.checked = Array.isArray(s.filterFormats) && s.filterFormats.length === 1 && s.filterFormats[0] === 'JPEG';
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
    pdfLayout: f.pdfLayout.value,
    orderMode: f.orderMode.value === 'dom' ? 'dom' : 'screen',
    previewSize: f.previewSize.value,
    thumbMaxSide: clamp(f.thumbMaxSide.value, 16, 4000, 300),
    scrollMaxScreens: clamp(f.scrollMaxScreens.value, 1, 200, 30),
    guessVariants: f.guessVariants.checked,
    scrollOnOpen: f.scrollOnOpen.checked,
    filterNoThumb: f.filterNoThumb.checked,
    filterFormats: f.jpgOnly.checked ? ['JPEG'] : null,
    filterMinWidth: clamp(f.filterMinWidth.value, 0, 100000, 0),
    filterMinHeight: clamp(f.filterMinHeight.value, 0, 100000, 0),
  });
  fill(s);
  document.querySelector('#saved').textContent = '저장되었습니다. 원본 판별 설정은 다음 검색부터 적용됩니다.';
});

async function showPermission() {
  const has = await chrome.permissions.contains(ALL);
  document.querySelector('#permState').textContent = has ? '현재 상태: 모든 사이트 접근 허용됨 (기본)' : '현재 상태: Chrome 설정에서 사이트 접근이 제한됨 — 필요할 때마다 묻습니다';
  document.querySelector('#grant').disabled = has;
}
document.querySelector('#grant').addEventListener('click', async () => {
  await chrome.permissions.request(ALL).catch(() => false);
  showPermission();
});
document.querySelector('#siteAccess').addEventListener('click', () => chrome.tabs.create({ url: `chrome://extensions/?id=${chrome.runtime.id}` }));
chrome.permissions.onAdded.addListener(showPermission);
chrome.permissions.onRemoved.addListener(showPermission);

fill(await loadSettings());
showPermission();
