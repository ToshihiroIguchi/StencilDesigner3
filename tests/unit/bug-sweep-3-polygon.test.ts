import { describe, it, expect, vi } from 'vitest';
import { History } from '../../src/state/history';
import { createDefaultState } from '../../src/types';
import type { Layer, Point } from '../../src/types';
import { PolygonTool } from '../../src/tools/polygon';
import type { ToolContext } from '../../src/tools/base';

function mkLayer(name: string, extra: Partial<Layer> = {}): Layer {
  return { ...createDefaultState().layers[0], name, visible: true, locked: false, ...extra };
}

function setup(layers: Layer[] = [mkLayer('A')], active = 'A') {
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
  return { history, ctx, notify, tool: new PolygonTool(ctx) };
}

function click(t: PolygonTool, history: History, p: Point): void {
  t.onMouseDown(p, p, false, history.state);
  t.onMouseUp(p, p, false, history.state);
}

const MSG_FEW = 'A polygon needs at least 3 vertices.';
const MSG_CROSS = "Can't close: the outline crosses itself. Press Backspace to remove the last vertex.";
const MSG_AREA =
  "Can't close: the shape has no area. Press Backspace to remove the last vertex or add more vertices.";

describe('polygon commit never silently discards a draft', () => {
  it('collinear vertices: notify, keep draft, then Backspace + valid vertex commits', () => {
    const { history, tool, notify } = setup();
    click(tool, history, { x: 0, y: 0 });
    click(tool, history, { x: 1000, y: 0 });
    click(tool, history, { x: 2000, y: 0 });
    tool.onKeyDown('Enter', history.state);
    expect(history.state.shapes).toHaveLength(0);
    expect(notify).toHaveBeenCalledWith(MSG_AREA);
    expect(tool.vertexCount()).toBe(3);

    tool.onKeyDown('Backspace', history.state);
    expect(tool.vertexCount()).toBe(2);
    click(tool, history, { x: 1000, y: 1000 });
    tool.onKeyDown('Enter', history.state);
    expect(history.state.shapes).toHaveLength(1);
    expect(tool.vertexCount()).toBe(0);
  });

  it('self-intersecting outline: notify, keep draft, Backspace then commits', () => {
    const { history, tool, notify } = setup();
    click(tool, history, { x: 0, y: 0 });
    click(tool, history, { x: 1000, y: 1000 });
    click(tool, history, { x: 1000, y: 0 });
    click(tool, history, { x: 0, y: 1000 });
    tool.onKeyDown('Enter', history.state);
    expect(history.state.shapes).toHaveLength(0);
    expect(notify).toHaveBeenCalledWith(MSG_CROSS);
    expect(tool.vertexCount()).toBe(4);

    tool.onKeyDown('Backspace', history.state);
    tool.onKeyDown('Enter', history.state);
    expect(history.state.shapes).toHaveLength(1);
    expect(tool.vertexCount()).toBe(0);
  });

  it('2 vertices via Enter: notify, keep draft', () => {
    const { history, tool, notify } = setup();
    click(tool, history, { x: 0, y: 0 });
    click(tool, history, { x: 1000, y: 0 });
    tool.onKeyDown('Enter', history.state);
    expect(history.state.shapes).toHaveLength(0);
    expect(notify).toHaveBeenCalledWith(MSG_FEW);
    expect(tool.vertexCount()).toBe(2);
  });

  it('double-click with 2 distinct vertices keeps the draft and notifies', () => {
    const { history, tool, notify } = setup();
    click(tool, history, { x: 0, y: 0 });
    click(tool, history, { x: 1000, y: 0 });
    tool.commitFromDblClick(history.state);
    expect(notify).toHaveBeenCalledWith(MSG_FEW);
    expect(tool.vertexCount()).toBe(2);
  });

  it('double-click failure on collinear keeps the draft', () => {
    const { history, tool, notify } = setup();
    click(tool, history, { x: 0, y: 0 });
    click(tool, history, { x: 1000, y: 0 });
    click(tool, history, { x: 2000, y: 0 });
    tool.commitFromDblClick(history.state);
    expect(notify).toHaveBeenCalledWith(MSG_AREA);
    expect(tool.vertexCount()).toBe(3);
  });

  it('willClose mouse-down path keeps the draft on failure', () => {
    const { history, tool, notify } = setup();
    click(tool, history, { x: 0, y: 0 });
    click(tool, history, { x: 1000, y: 0 });
    click(tool, history, { x: 2000, y: 0 });
    const state = history.state;
    tool.onMouseMove({ x: 0, y: 0 }, { x: 0, y: 0 }, false, state);
    tool.onMouseDown({ x: 0, y: 0 }, { x: 0, y: 0 }, false, state);
    expect(state.shapes).toHaveLength(0);
    expect(notify).toHaveBeenCalledWith(MSG_AREA);
    expect(tool.vertexCount()).toBe(3);
  });

  it('locked active layer refuses but keeps the draft', () => {
    const { history, tool, notify } = setup([mkLayer('A', { locked: true })], 'A');
    click(tool, history, { x: 0, y: 0 });
    click(tool, history, { x: 1000, y: 0 });
    click(tool, history, { x: 1000, y: 1000 });
    tool.onKeyDown('Enter', history.state);
    expect(history.state.shapes).toHaveLength(0);
    expect(notify).toHaveBeenCalledWith('Active layer is locked');
    expect(tool.vertexCount()).toBe(3);
  });

  it('valid triangle commits and clears the draft', () => {
    const { history, tool, notify } = setup();
    click(tool, history, { x: 0, y: 0 });
    click(tool, history, { x: 1000, y: 0 });
    click(tool, history, { x: 1000, y: 1000 });
    tool.onKeyDown('Enter', history.state);
    expect(history.state.shapes).toHaveLength(1);
    expect(tool.vertexCount()).toBe(0);
    expect(notify).not.toHaveBeenCalled();
  });
});
