import { describe, it, expect, beforeEach, vi } from 'vitest';
import { uniqueUntitledName } from '../../src/state/docStore';
import type { DocMetadata } from '../../src/state/docStore';

// localforage is browser-only; mock it for unit tests
vi.mock('localforage', () => {
  const store = new Map<string, unknown>();
  return {
    default: {
      setItem: async (k: string, v: unknown) => { store.set(k, v); },
      getItem: async (k: string) => store.get(k) ?? null,
      removeItem: async (k: string) => { store.delete(k); },
    },
  };
});

// ── uniqueUntitledName ────────────────────────────────────────────────────────

describe('uniqueUntitledName', () => {
  const meta = (name: string): DocMetadata => ({
    id: crypto.randomUUID(),
    name,
    lastModified: Date.now(),
    sizeBytes: 100,
  });

  it('returns "Untitled" when no docs exist', () => {
    expect(uniqueUntitledName([])).toBe('Untitled');
  });

  it('returns "Untitled" when only other names exist', () => {
    expect(uniqueUntitledName([meta('Board A')])).toBe('Untitled');
  });

  it('returns "Untitled 2" when "Untitled" exists', () => {
    expect(uniqueUntitledName([meta('Untitled')])).toBe('Untitled 2');
  });

  it('returns "Untitled 3" when "Untitled" and "Untitled 2" exist', () => {
    expect(uniqueUntitledName([meta('Untitled'), meta('Untitled 2')])).toBe('Untitled 3');
  });

  it('skips gaps — uses first available number', () => {
    // "Untitled" and "Untitled 3" exist but not "Untitled 2"
    expect(uniqueUntitledName([meta('Untitled'), meta('Untitled 3')])).toBe('Untitled 2');
  });
});

// ── CRUD round-trip (mocked localforage) ─────────────────────────────────────

describe('docStore CRUD', () => {
  beforeEach(async () => {
    // Reset mocked store before each test by re-importing with fresh mock
    vi.resetModules();
  });

  it('createDoc adds to list and loadDoc returns a state', async () => {
    const { createDoc, listDocs, loadDoc } = await import('../../src/state/docStore');
    const meta = await createDoc('Test Doc');
    expect(meta.name).toBe('Test Doc');
    expect(meta.id).toBeTruthy();

    const list = await listDocs();
    expect(list.some((d) => d.id === meta.id)).toBe(true);

    const state = await loadDoc(meta.id);
    expect(state).not.toBeNull();
    expect(state?.schemaVersion).toBeGreaterThanOrEqual(6);
  });

  it('deleteDoc removes from list and loadDoc returns null', async () => {
    const { createDoc, deleteDoc, listDocs, loadDoc } = await import('../../src/state/docStore');
    const meta = await createDoc('To Delete');
    await deleteDoc(meta.id);

    const list = await listDocs();
    expect(list.some((d) => d.id === meta.id)).toBe(false);

    const state = await loadDoc(meta.id);
    expect(state).toBeNull();
  });

  it('renameDoc updates name in list', async () => {
    const { createDoc, renameDoc, listDocs } = await import('../../src/state/docStore');
    const meta = await createDoc('Old Name');
    await renameDoc(meta.id, 'New Name');
    const list = await listDocs();
    expect(list.find((d) => d.id === meta.id)?.name).toBe('New Name');
  });

  it('migrateState normalizes geometry on loadDoc', async () => {
    const { createDoc, loadDoc } = await import('../../src/state/docStore');
    const meta = await createDoc('Dirty Geometry');
    const state = await loadDoc(meta.id);
    if (!state) throw new Error('State is null');

    const badPoly = {
      id: 'p-bad',
      layer: '0',
      outer: [
        { id: 'v1', x: 0, y: 0 },
        { id: 'v2', x: 1000, y: 0 },
        { id: 'v2-dup', x: 1000, y: 0 },
        { id: 'v3', x: 1000, y: 1000 },
        { id: 'v4', x: 0, y: 1000 },
      ],
      holes: [],
    };
    state.shapes = [badPoly];

    const localforage = (await import('localforage')).default;
    await localforage.setItem(`doc:${meta.id}`, JSON.parse(JSON.stringify(state)));

    const loaded = await loadDoc(meta.id);
    expect(loaded).not.toBeNull();
    expect(loaded!.shapes.length).toBe(1);
    expect(loaded!.shapes[0].outer.length).toBe(4);
  });
});
