import type { AppState } from '../types';
import localforage from 'localforage';

const STORE_KEY = 'stencil_designer_autosave';
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

/** Load previously saved state, or null if nothing saved. */
export async function loadState(): Promise<AppState | null> {
  return localforage.getItem<AppState>(STORE_KEY);
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
