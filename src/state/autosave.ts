import localforage from 'localforage';

const PREFS_KEY = 'stencil_designer_prefs';

export interface AppPrefs {
  filletRadius: number;
  drcMinApertureUm: number;
  drcMinSpacingUm: number;
}

const DEFAULT_PREFS: AppPrefs = { filletRadius: 500, drcMinApertureUm: 30, drcMinSpacingUm: 30 };

let prefsCache: AppPrefs | null = null;

export async function savePrefs(prefs: Partial<AppPrefs>): Promise<void> {
  if (prefsCache === null) prefsCache = await loadPrefs();
  prefsCache = { ...prefsCache, ...prefs };
  await localforage.setItem(PREFS_KEY, prefsCache);
}

export async function loadPrefs(): Promise<AppPrefs> {
  if (prefsCache !== null) return prefsCache;
  const stored = await localforage.getItem<Partial<AppPrefs>>(PREFS_KEY);
  prefsCache = { ...DEFAULT_PREFS, ...(stored ?? {}) };
  return prefsCache;
}
