import { describe, it, expect, vi, beforeEach } from 'vitest';

const store = new Map<string, unknown>();

vi.mock('localforage', () => ({
  default: {
    setItem: async (k: string, v: unknown) => {
      // Yield so concurrent read-modify-write sequences interleave.
      await new Promise((r) => setTimeout(r, 1));
      store.set(k, JSON.parse(JSON.stringify(v)));
    },
    getItem: async (k: string) => {
      await new Promise((r) => setTimeout(r, 1));
      const v = store.get(k);
      return v === undefined ? null : JSON.parse(JSON.stringify(v));
    },
    removeItem: async (k: string) => { store.delete(k); },
  },
}));

beforeEach(() => {
  store.clear();
  vi.resetModules();
});

describe('migrateState layer repair (via loadDoc)', () => {
  it('resets a missing activeLayerName and reassigns orphan layers to 0', async () => {
    const m = await import('../../src/state/docStore');
    const { createDefaultState } = await import('../../src/types');
    const base = createDefaultState();
    const bad = {
      ...base,
      layers: base.layers.filter((l) => l.name !== '0').concat([
        { name: 'A', visible: true, locked: false, color: '#fff', isAperture: true },
      ] as typeof base.layers),
      activeLayerName: 'GONE',
      shapes: [{ id: 's', outer: [], holes: [], layer: 'GONE' }],
      dimensions: [{ id: 'd', kind: 'h', anchor1: { kind: 'free', point: { x: 0, y: 0 } },
        anchor2: { kind: 'free', point: { x: 1, y: 1 } }, offset: 0, layer: 'NOPE' }],
      annotations: [{ id: 'a', layer: 'NOPE2' }],
    };
    store.set('doc:x', bad);
    const s = (await m.loadDoc('x'))!;
    const names = s.layers.map((l) => l.name);
    expect(names).toContain('0');
    expect(names).toContain(s.activeLayerName);
    expect(s.activeLayerName).not.toBe('DIMENSIONS');
    for (const sh of s.shapes) expect(names).toContain(sh.layer);
    for (const d of s.dimensions) expect(names).toContain(d.layer);
    for (const a of s.annotations) expect(names).toContain((a as { layer: string }).layer);
  });
});

describe('doc_list locking', () => {
  it('does not lose metadata under concurrent createDoc/saveDoc/renameDoc', async () => {
    const m = await import('../../src/state/docStore');
    const { createDefaultState } = await import('../../src/types');
    const a = await m.createDoc('A');
    const results = await Promise.all([
      m.createDoc('B'),
      m.saveDoc(a.id, createDefaultState()),
      m.renameDoc(a.id, 'A2'),
      m.createDoc('C'),
    ]);
    expect(results).toBeDefined();
    const list = await m.listDocs();
    expect(list.map((d) => d.name).sort()).toEqual(['A2', 'B', 'C']);
  });
});

describe('validateStencilJson', () => {
  it('accepts valid and rejects malformed input', async () => {
    const { validateStencilJson } = await import('../../src/ui/fileManager');
    expect(() => validateStencilJson({ shapes: [], layers: [] })).not.toThrow();
    expect(() => validateStencilJson({})).not.toThrow();
    expect(() => validateStencilJson([])).toThrow();
    expect(() => validateStencilJson(null)).toThrow();
    expect(() => validateStencilJson({ shapes: {} })).toThrow();
    expect(() => validateStencilJson({ layers: 'x' })).toThrow();
  });
});
