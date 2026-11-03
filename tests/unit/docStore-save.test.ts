import { describe, it, expect, vi, beforeEach } from 'vitest';

const store = new Map<string, unknown>();
let setDelay: Promise<void> | null = null;
let failNext = false;

vi.mock('localforage', () => ({
  default: {
    setItem: async (k: string, v: unknown) => {
      if (setDelay) await setDelay;
      if (failNext && k.startsWith('doc:')) { failNext = false; throw new Error('boom'); }
      store.set(k, v);
    },
    getItem: async (k: string) => store.get(k) ?? null,
    removeItem: async (k: string) => { store.delete(k); },
  },
}));

beforeEach(() => {
  store.clear();
  setDelay = null;
  failNext = false;
  vi.resetModules();
});

describe('saveDoc', () => {
  it('keeps the dirty flag when an edit happens during the write', async () => {
    const m = await import('../../src/state/docStore');
    const { createDefaultState } = await import('../../src/types');
    const meta = await m.createDoc('A');
    let release!: () => void;
    setDelay = new Promise<void>((r) => { release = r; });
    m.markDirty();
    const p = m.saveDoc(meta.id, createDefaultState());
    await new Promise((r) => setTimeout(r, 0));
    m.markDirty(); // edit while the write is in flight
    release();
    await p;
    expect(m.getIsDirty()).toBe(true);
  });

  it('restores the dirty flag when the write fails', async () => {
    const m = await import('../../src/state/docStore');
    const { createDefaultState } = await import('../../src/types');
    const meta = await m.createDoc('A');
    m.markDirty();
    failNext = true;
    await expect(m.saveDoc(meta.id, createDefaultState())).rejects.toThrow('boom');
    expect(m.getIsDirty()).toBe(true);
  });

  it('does not resurrect a deleted doc', async () => {
    const m = await import('../../src/state/docStore');
    const { createDefaultState } = await import('../../src/types');
    const meta = await m.createDoc('A');
    await m.deleteDoc(meta.id);
    m.markDirty();
    await m.saveDoc(meta.id, createDefaultState());
    expect(store.has(`doc:${meta.id}`)).toBe(false);
    expect(m.getIsDirty()).toBe(false);
  });
});
