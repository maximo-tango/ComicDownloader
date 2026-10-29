// Opening the popup grants activeTab for the current tab, which is what lets
// the analyser read this page without permanent access to every site.
const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
const analysable = tab && /^(https?|file):/.test(tab.url || '');
document.querySelector('#page').textContent = tab?.title || tab?.url || '';
const analyze = document.querySelector('#analyze');
if (!analysable) {
  analyze.disabled = true;
  const note = document.querySelector('#note');
  note.hidden = false;
  note.textContent = 'Chrome 내부 페이지나 웹 스토어는 분석할 수 없습니다. 일반 웹페이지에서 다시 열어 주세요.';
}

const openApp = async (params) => {
  await chrome.tabs.create({ url: chrome.runtime.getURL(`app/app.html?${new URLSearchParams(params)}`), index: tab ? tab.index + 1 : undefined });
  window.close();
};
analyze.addEventListener('click', () => openApp({ tabId: tab.id }));
document.querySelector('#paste').addEventListener('click', () => openApp({ view: 'paste' }));
// Pre-fill the series with the current page's address.
document.querySelector('#batch').addEventListener('click', () => openApp({ view: 'batch', ...(analysable && /^https?:/.test(tab.url) ? { url: tab.url } : {}) }));
document.querySelector('#downloads').addEventListener('click', () => openApp({ view: 'downloads' }));
document.querySelector('#options').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
  window.close();
});
