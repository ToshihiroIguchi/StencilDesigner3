import type { AppState, Dimension, DimensionAnchor } from '../types';
import { createDefaultState, defaultLayers } from '../types';
import { vertex } from '../core/vertex';
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
    // v1→v2: layer system added.
    // Note: defaultLayers() returns the current (v3) defaults including REGMARK,
    // so v1 data already has REGMARK after this step and skips the v2→v3 injection.
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

  if (v < 3) {
    // v2→v3: REGMARK layer added. Append only if missing so user-deleted REGMARK
    // stays deleted after the first v3 save.
    const REGMARK_TEMPLATE = defaultLayers().find((l) => l.name === 'REGMARK')!;
    const existingLayers = state.layers ?? defaultLayers();
    state = {
      ...state,
      schemaVersion: 3,
      layers: existingLayers.some((l) => l.name === 'REGMARK')
        ? existingLayers
        : [...existingLayers, REGMARK_TEMPLATE],
    };
  }

  if (v < 4) {
    // v3→v4: Vertex IDs added to Ring. All vertices without an 'id' get one.
    // Old Dimension format used p1/p2; convert to free anchors.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const assignIds = (ring: any[]): any[] =>
      ring.map((p: any) => (p.id ? p : vertex(p.x, p.y)));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const migratedShapes = ((state.shapes ?? []) as any[]).map((shape: any) => ({
      ...shape,
      outer: assignIds(shape.outer ?? []),
      holes: (shape.holes ?? []).map(assignIds),
    }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const migratedDims: Dimension[] = ((state as any).dimensions ?? []).map((d: any): Dimension => {
      if (d.anchor1 && d.anchor2) return d as Dimension; // already v4
      const freeAnchor = (pt: { x: number; y: number }): DimensionAnchor => ({
        kind: 'free',
        point: { x: pt.x, y: pt.y },
      });
      return {
        id: d.id,
        kind: d.kind,
        anchor1: freeAnchor(d.p1 ?? { x: 0, y: 0 }),
        anchor2: freeAnchor(d.p2 ?? { x: 0, y: 0 }),
        offset: d.offset ?? 0,
        layer: d.layer ?? 'DIMENSIONS',
        frozen: true,
      };
    });
    state = {
      ...state,
      schemaVersion: 4,
      shapes: migratedShapes,
      dimensions: migratedDims,
    };
  }

  // Inject new fields added after v2 if missing
  const finalState = {
    ...(state as AppState),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    dimensions: (state as any).dimensions ?? [],
  };

  // Fill in missing isAperture from defaults (old saves lack this field)
  const defaultApertureMap: Record<string, boolean> = Object.fromEntries(
    defaultLayers().map((l) => [l.name, l.isAperture])
  );
  finalState.layers = finalState.layers.map((l) => {
    if (l.name === 'DIMENSIONS') return { ...l, isAperture: false, plot: false };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if ((l as any).isAperture === undefined) {
      return { ...l, isAperture: defaultApertureMap[l.name] ?? false };
    }
    return l;
  });
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
