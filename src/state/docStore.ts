import type { AppState, Dimension, DimensionAnchor } from '../types';
import { createDefaultState, defaultLayers, REGMARK_LAYER, DIMENSIONS_LAYER } from '../types';
import { vertex } from '../core/vertex';
import localforage from 'localforage';

const DOC_LIST_KEY = 'doc_list';
const CURRENT_DOC_KEY = 'current_doc_id';
const LEGACY_KEY = 'stencil_designer_autosave';
const SAVE_INTERVAL_MS = 5000;

export interface DocMetadata {
  id: string;
  name: string;
  lastModified: number;
  sizeBytes: number;
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
let isDirty = false;

export function markDirty(): void {
  isDirty = true;
}

async function setList(list: DocMetadata[]): Promise<void> {
  await localforage.setItem(DOC_LIST_KEY, list);
}

export async function listDocs(): Promise<DocMetadata[]> {
  const list = await localforage.getItem<DocMetadata[]>(DOC_LIST_KEY);
  return list ?? [];
}

export async function loadDoc(id: string): Promise<AppState | null> {
  const raw = await localforage.getItem<unknown>(`doc:${id}`);
  if (!raw) return null;
  return migrateState(raw as Partial<AppState>);
}

export async function saveDoc(id: string, state: AppState): Promise<void> {
  const snapshot = JSON.parse(JSON.stringify(state)) as AppState;
  await localforage.setItem(`doc:${id}`, snapshot);
  isDirty = false;
  const list = await listDocs();
  const idx = list.findIndex((d) => d.id === id);
  if (idx >= 0) {
    list[idx].lastModified = Date.now();
    list[idx].sizeBytes = JSON.stringify(state).length;
    await setList(list);
  }
}

export async function createDoc(name?: string): Promise<DocMetadata> {
  const id = crypto.randomUUID();
  const state = createDefaultState();
  await localforage.setItem(`doc:${id}`, JSON.parse(JSON.stringify(state)));
  const meta: DocMetadata = {
    id,
    name: name ?? 'Untitled',
    lastModified: Date.now(),
    sizeBytes: JSON.stringify(state).length,
  };
  const list = await listDocs();
  list.push(meta);
  await setList(list);
  return meta;
}

export async function deleteDoc(id: string): Promise<void> {
  await localforage.removeItem(`doc:${id}`);
  const list = await listDocs();
  await setList(list.filter((d) => d.id !== id));
}

export async function renameDoc(id: string, name: string): Promise<void> {
  const list = await listDocs();
  const meta = list.find((d) => d.id === id);
  if (meta) {
    meta.name = name;
    await setList(list);
  }
}

export async function getCurrentDocId(): Promise<string | null> {
  return localforage.getItem<string>(CURRENT_DOC_KEY);
}

export async function setCurrentDocId(id: string | null): Promise<void> {
  if (id) {
    await localforage.setItem(CURRENT_DOC_KEY, id);
  } else {
    await localforage.removeItem(CURRENT_DOC_KEY);
  }
}

export async function getStorageEstimate(): Promise<{ usage: number; quota: number } | null> {
  if (!navigator.storage?.estimate) return null;
  const est = await navigator.storage.estimate();
  if (est.usage === undefined || est.quota === undefined) return null;
  return { usage: est.usage, quota: est.quota };
}

export async function migrateLegacyKey(): Promise<void> {
  await localforage.removeItem(LEGACY_KEY);
}

export function uniqueUntitledName(docs: DocMetadata[]): string {
  const used = new Set(docs.map((d) => d.name));
  if (!used.has('Untitled')) return 'Untitled';
  for (let i = 2; ; i++) {
    const n = `Untitled ${i}`;
    if (!used.has(n)) return n;
  }
}

export function startDocAutosave(
  getDocId: () => string | null,
  getState: () => AppState,
  onError: (msg: string) => void
): () => void {
  const tick = async () => {
    const id = getDocId();
    if (isDirty && id) {
      try {
        await saveDoc(id, getState());
      } catch (e) {
        if (e instanceof DOMException && e.name === 'QuotaExceededError') {
          onError('Storage full — please download or delete documents');
        }
      }
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

export async function saveDocAndStop(id: string, state: AppState): Promise<void> {
  if (saveTimer !== null) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  await saveDoc(id, state);
}

// ── Schema migration (handles JSON files imported from disk as well) ──────────

function migrateState(s: Partial<AppState>): AppState {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const v = (s as any).schemaVersion ?? 1;
  let state: Partial<AppState> = s;

  if (v < 2) {
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
    const existingLayers = state.layers ?? defaultLayers();
    state = {
      ...state,
      schemaVersion: 3,
      layers: existingLayers.some((l) => l.name === 'REGMARK')
        ? existingLayers
        : [...existingLayers, { ...REGMARK_LAYER }],
    };
  }

  if (v < 4) {
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
      if (d.anchor1 && d.anchor2) return d as Dimension;
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

  if (v < 5) {
    const LEGACY = new Set(['REGMARK', 'OUTLINE']);
    const newLayers = (state.layers ?? []).filter((l) => !LEGACY.has(l.name));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const newShapes = ((state.shapes ?? []) as any[]).map((s: any) =>
      LEGACY.has(s.layer) ? { ...s, layer: '0' } : s
    );
    state = { ...state, schemaVersion: 5, layers: newLayers, shapes: newShapes };
  }

  if (v < 6) {
    state = { ...state, schemaVersion: 6, displayUnit: 'mm' };
  }

  const finalState = {
    ...(state as AppState),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    dimensions: (state as any).dimensions ?? [],
  };

  const defaultApertureMap: Record<string, boolean> = {
    '0': true, REGMARK: true, OUTLINE: false, DIMENSIONS: false,
  };
  finalState.layers = finalState.layers.map((l) => {
    if (l.name === 'DIMENSIONS') return { ...DIMENSIONS_LAYER, visible: l.visible, locked: l.locked };
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
