import { describe, it, expect, vi } from 'vitest';
import { History } from '../../src/state/history';
import { createDefaultState } from '../../src/types';
import type { Layer } from '../../src/types';
import { AddLayerCommand, RenameLayerCommand, canRenameLayer, layerNameTaken } from '../../src/state/commands';
import { DimensionTool } from '../../src/tools/dimension';
import { ArrowTool } from '../../src/tools/arrow';
import { AnnotationTool } from '../../src/tools/annotation';
import type { ToolContext } from '../../src/tools/base';

function mkLayer(name: string, extra: Partial<Layer> = {}): Layer {
  return { ...createDefaultState().layers[0], name, visible: true, locked: false, ...extra };
}

describe('layer naming rules', () => {
  const layers = [mkLayer('0'), mkLayer('Wall'), mkLayer('DIMENSIONS')];

  it('treats names case-insensitively', () => {
    expect(layerNameTaken(layers, 'WALL')).toBe(true);
    expect(layerNameTaken(layers, 'wall', 'Wall')).toBe(false);
    expect(layerNameTaken(layers, 'Other')).toBe(false);
  });

  it('AddLayerCommand rejects a case-variant duplicate', () => {
    const s = createDefaultState();
    s.layers = layers;
    const after = new AddLayerCommand(mkLayer('wall')).do(s);
    expect(after.layers).toHaveLength(3);
  });

  it('allows a case-only rename of the same layer', () => {
    expect(canRenameLayer(layers, 'Wall', 'WALL')).toBe(true);
  });

  it('forbids renaming DIMENSIONS or renaming onto it', () => {
    expect(canRenameLayer(layers, 'DIMENSIONS', 'Dims')).toBe(false);
    expect(canRenameLayer(layers, 'Wall', 'dimensions')).toBe(false);
    const s = createDefaultState();
    s.layers = layers;
    const cmd = new RenameLayerCommand('DIMENSIONS', 'Dims');
    expect(cmd.do(s)).toBe(s);
    expect(cmd.undo(s)).toBe(s);
  });

  it('forbids renaming onto an existing layer in another case', () => {
    expect(canRenameLayer([...layers, mkLayer('Hole')], 'Hole', 'wALL')).toBe(false);
  });
});

function setup(dimExtra: Partial<Layer> | null) {
  const s = createDefaultState();
  s.layers = [mkLayer('0'), ...(dimExtra ? [mkLayer('DIMENSIONS', dimExtra)] : [])];
  s.activeLayerName = '0';
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

describe('DIMENSIONS layer hidden or locked blocks annotation tools', () => {
  for (const [label, extra, msg] of [
    ['locked', { locked: true }, 'DIMENSIONS layer is locked'],
    ['hidden', { visible: false }, 'DIMENSIONS layer is hidden'],
  ] as const) {
    it(`dimension tool refuses when ${label}`, () => {
      const { history, ctx, notify } = setup(extra);
      const tool = new DimensionTool(ctx);
      tool.onMouseDown({ x: 0, y: 0 }, { x: 0, y: 0 }, false, history.state);
      expect(notify).toHaveBeenCalledWith(msg);
      expect(history.state.dimensions).toHaveLength(0);
    });

    it(`arrow tool refuses when ${label}`, () => {
      const { history, ctx, notify } = setup(extra);
      const tool = new ArrowTool(ctx);
      tool.onMouseDown({ x: 0, y: 0 }, { x: 0, y: 0 }, false, history.state);
      tool.onMouseUp({ x: 5000, y: 0 }, { x: 0, y: 0 }, false, history.state);
      expect(notify).toHaveBeenCalledWith(msg);
      expect(history.state.dimensions).toHaveLength(0);
    });
  }

  it('annotation tool does not open the overlay when locked', () => {
    const { history, ctx, notify } = setup({ locked: true });
    const tool = new AnnotationTool(ctx);
    const spy = vi.spyOn(tool as never, 'openOverlay' as never);
    tool.onMouseDown({ x: 0, y: 0 }, { x: 0, y: 0 }, false, history.state);
    expect(notify).toHaveBeenCalledWith('DIMENSIONS layer is locked');
    expect(spy).not.toHaveBeenCalled();
  });

  it('dimension tool proceeds when the layer does not exist yet or is usable', () => {
    for (const extra of [null, {}]) {
      const { history, ctx, notify } = setup(extra);
      const tool = new DimensionTool(ctx);
      tool.onMouseDown({ x: 0, y: 0 }, { x: 0, y: 0 }, false, history.state);
      expect(notify).not.toHaveBeenCalled();
    }
  });
});
