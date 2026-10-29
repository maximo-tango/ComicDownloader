export const DEFAULT_SETTINGS = {
  rootFolder: 'ImageHunter',
  folderMode: 'page', // 'page' (page title) | 'site' | 'none'
  conflictAction: 'uniquify', // never overwrite by default
  concurrency: 3,
  thumbMaxSide: 300,
  guessVariants: false, // URL-pattern guesses are opt-in
  previewSize: 'medium', // 'small' | 'medium' | 'large'
  scrollMaxScreens: 30, // auto-scroll never runs unbounded
  // Starting state of the image list
  filterNoThumb: true, // "썸네일 의심 제외" checked
  filterFormats: ['JPEG'], // format chips switched on (empty/null = all)
  scrollOnOpen: true, // first search scrolls the page to load lazy images
  pdfLayout: 'continuous', // 'continuous' (images joined, no gaps) | 'page' (one image per page) | 'a4'
};

export async function loadSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return { ...DEFAULT_SETTINGS, ...(settings || {}) };
}

export async function saveSettings(patch) {
  const next = { ...(await loadSettings()), ...patch };
  await chrome.storage.local.set({ settings: next });
  return next;
}
