export const DEFAULT_SETTINGS = {
  rootFolder: 'Image Hunter',
  perSiteFolder: true,
  conflictAction: 'uniquify', // never overwrite by default
  concurrency: 3,
  thumbMaxSide: 300,
  setReferer: true,
  autoSkipFailed: false,
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
