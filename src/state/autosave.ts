import type { AppState } from '../types';
import { createDefaultState, defaultLayers } from '../types';
import localforage from 'localforage';

const STORE_KEY = 'stencil_designer_autosave';
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
const SAVE_INTERVAL_MS = 5000;

let saveTimer: ReturnType<typeof setTimeout> | null = null;
let isDirty = false;

export function markDirty(): void {
  isDirty = true;
}

export function markClean(): void {
  isDirty = false;
}

/** Save state to IndexedDB immediately. */
export async function saveState(state: AppState): Promise<void> {
  const snapshot = JSON.parse(JSON.stringify(state)) as AppState;
  await localforage.setItem(STORE_KEY, snapshot);
  isDirty = false;
}

/** Load previously saved state, or null if nothing saved. Migrates from older schemas. */
export async function loadState(): Promise<AppState | null> {
  const raw = await localforage.getItem<unknown>(STORE_KEY);
  if (!raw) return null;
  return migrateState(raw as Partial<AppState>);
}

function migrateState(s: Partial<AppState>): AppState {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const v = (s as any).schemaVersion ?? 1;
  let state: Partial<AppState> = s;

  if (v < 2) {
    // v1→v2: layer system added
    state = {
      ...createDefaultState(),
      ...state,
      layers: defaultLayers(),
      activeLayerName: '0',
      schemaVersion: 2,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      shapes: ((state.shapes as any[]) ?? []).map((p: any) => ({ ...p, layer: '0' })),
    };
  }

  // Inject new fields added after v2 if missing
  const finalState = {
    ...(state as AppState),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    dimensions: (state as any).dimensions ?? [],
  };

  // Enforce DIMENSIONS layer invariants: never aperture, gray color
  finalState.layers = finalState.layers.map((l) =>
    l.name === 'DIMENSIONS' ? { ...l, isAperture: false, plot: false, color: '#888888' } : l
  );
  if (finalState.activeLayerName === 'DIMENSIONS') {
    const fallback = finalState.layers.find((l) => l.name !== 'DIMENSIONS' && l.visible);
    if (fallback) finalState.activeLayerName = fallback.name;
  }

  return finalState;
}

/** Clear saved state. */
export async function clearState(): Promise<void> {
  await localforage.removeItem(STORE_KEY);
}

/** Start the autosave interval. Callback provides current state when needed. */
export function startAutosave(getState: () => AppState): () => void {
  const tick = async () => {
    if (isDirty) {
      await saveState(getState());
    }
    saveTimer = setTimeout(tick, SAVE_INTERVAL_MS);
  };
  saveTimer = setTimeout(tick, SAVE_INTERVAL_MS);

  return () => {
    if (saveTimer !== null) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
  };
}

/** Save immediately and cancel the timed autosave. */
export async function saveAndStop(state: AppState): Promise<void> {
  if (saveTimer !== null) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  await saveState(state);
}

export function hasSavedState(): Promise<boolean> {
  return localforage.getItem<AppState>(STORE_KEY).then((v) => v !== null);
}
