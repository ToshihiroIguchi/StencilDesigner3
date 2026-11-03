import { describe, it, expect, vi } from 'vitest';
import { History } from '../../src/state/history';
import { createDefaultState } from '../../src/types';
import type { Layer } from '../../src/types';
import { UpdateLayerStyleCommand } from '../../src/state/commands';
import { RectTool } from '../../src/tools/rect';
import { CircleTool } from '../../src/tools/circle';
import { PolygonTool } from '../../src/tools/polygon';
import type { ToolContext } from '../../src/tools/base';

function mkLayer(name: string, extra: Partial<Layer> = {}): Layer {
  return { ...createDefaultState().layers[0], name, visible: true, locked: false, ...extra };
}

function setup(layers: Layer[], active: string) {
  const s = createDefaultState();
  s.layers = layers;
  s.activeLayerName = active;
  const history = new History(s);
  const notify = vi.fn();
  const ctx: ToolContext = {
    history,
    getSnap: (p) => ({ point: p, kind: 'none' } as never),
    getSelectionSnap: () => ({ delta: { x: 0, y: 0 }, kind: 'none', targetPoint: null } as never),
    requestRender: () => {},
    notify,
  };
  return { history, ctx, notify };
}

describe('layer lock command', () => {
  it('locking the active layer moves active to an unlocked visible layer; undo restores', () => {
    const s = createDefaultState();
    s.layers = [mkLayer('A'), mkLayer('L', { locked: true }), mkLayer('DIMENSIONS'), mkLayer('B')];
    s.activeLayerName = 'A';
    const cmd = new UpdateLayerStyleCommand('A', { locked: true });
    const after = cmd.do(s);
    expect(after.layers.find((l) => l.name === 'A')?.locked).toBe(true);
    expect(after.activeLayerName).toBe('B');
    const back = cmd.undo(after);
    expect(back.activeLayerName).toBe('A');
    expect(back.layers.find((l) => l.name === 'A')?.locked).toBe(false);
  });

  it('unlocking leaves the active layer alone', () => {
    const s = createDefaultState();
    s.layers = [mkLayer('A'), mkLayer('B', { locked: true })];
    s.activeLayerName = 'A';
    const after = new UpdateLayerStyleCommand('B', { locked: false }).do(s);
    expect(after.activeLayerName).toBe('A');
    expect(after.layers[1].locked).toBe(false);
  });

  it('keeps active layer when no other candidate exists', () => {
    const s = createDefaultState();
    s.layers = [mkLayer('A')];
    s.activeLayerName = 'A';
    const after = new UpdateLayerStyleCommand('A', { locked: true }).do(s);
    expect(after.activeLayerName).toBe('A');
  });
});

describe('drawing tools refuse a locked active layer', () => {
  it('rect panel placement and click placement', () => {
    const { history, ctx, notify } = setup([mkLayer('A', { locked: true })], 'A');
    const t = new RectTool(ctx);
    t.placeFromPanel(history.state);
    expect(history.state.shapes).toHaveLength(0);
    t.onMouseDown({ x: 0, y: 0 }, { x: 0, y: 0 }, false, history.state);
    t.onMouseUp({ x: 0, y: 0 }, { x: 0, y: 0 }, false, history.state);
    expect(history.state.shapes).toHaveLength(0);
    expect(notify).toHaveBeenCalledWith('Active layer is locked');
  });

  it('circle panel placement and click placement', () => {
    const { history, ctx, notify } = setup([mkLayer('A', { locked: true })], 'A');
    const t = new CircleTool(ctx);
    t.placeFromPanel(history.state);
    t.onMouseDown({ x: 0, y: 0 }, { x: 0, y: 0 }, false, history.state);
    t.onMouseUp({ x: 0, y: 0 }, { x: 0, y: 0 }, false, history.state);
    expect(history.state.shapes).toHaveLength(0);
    expect(notify).toHaveBeenCalledWith('Active layer is locked');
  });

  it('polygon commit', () => {
    const { history, ctx, notify } = setup([mkLayer('A', { locked: true })], 'A');
    const t = new PolygonTool(ctx);
    const pts = [{ x: 0, y: 0 }, { x: 1000, y: 0 }, { x: 1000, y: 1000 }];
    for (const p of pts) {
      t.onMouseDown(p, p, false, history.state);
      t.onMouseUp(p, p, false, history.state);
    }
    t.commitFromDblClick(history.state);
    expect(history.state.shapes).toHaveLength(0);
    expect(notify).toHaveBeenCalledWith('Active layer is locked');
  });

  it('rect still draws on an unlocked layer', () => {
    const { history, ctx, notify } = setup([mkLayer('A')], 'A');
    new RectTool(ctx).placeFromPanel(history.state);
    expect(history.state.shapes).toHaveLength(1);
    expect(notify).not.toHaveBeenCalled();
  });
});
