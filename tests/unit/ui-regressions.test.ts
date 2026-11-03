import { describe, it, expect, vi } from 'vitest';
import { SelectTool } from '../../src/tools/select';
import type { ToolContext } from '../../src/tools/base';
import { History } from '../../src/state/history';
import { createDefaultState } from '../../src/types';
import { rectToPolygon } from '../../src/core/geometry';
import { MoveCommand } from '../../src/state/commands';
import * as docStore from '../../src/state/docStore';

function setup() {
  const state = createDefaultState();
  state.zoom = 1;
  state.panX = 0;
  state.panY = 0;
  const poly = rectToPolygon(0, 0, 1000, 1000);
  state.shapes = [poly];
  const history = new History(state);
  const ctx: ToolContext = {
    history,
    getSnap: (p) => ({ point: p, kind: 'none' } as never),
    getSelectionSnap: (_m, start, cur) => ({
      delta: { x: cur.x - start.x, y: cur.y - start.y }, kind: 'none', targetPoint: null,
    } as never),
    requestRender: () => {},
    notify: () => {},
  };
  return { state, history, ctx, poly, tool: new SelectTool(ctx) };
}

describe('selection is not recorded in history', () => {
  it('click select / deselect leaves undo stack empty', () => {
    const { history, tool } = setup();
    tool.onMouseDown({ x: 500, y: 500 }, { x: 500, y: 500 }, false, history.state);
    tool.onMouseUp({ x: 500, y: 500 }, { x: 500, y: 500 }, false, history.state);
    expect(history.state.selection.length).toBe(1);
    expect(history.canUndo()).toBe(false);
    tool.onMouseDown({ x: 5000, y: 5000 }, { x: 5000, y: 5000 }, false, history.state);
    tool.onMouseUp({ x: 5000, y: 5000 }, { x: 5000, y: 5000 }, false, history.state);
    expect(history.state.selection.length).toBe(0);
    expect(history.canUndo()).toBe(false);
  });

  it('selection change does not clear redo stack', () => {
    const { history, tool, poly } = setup();
    history.execute(new MoveCommand([{ type: 'polygon', shapeId: poly.id, index: -1, holeIndex: -1 }], 10, 0));
    history.undo();
    expect(history.canRedo()).toBe(true);
    tool.onMouseDown({ x: 500, y: 500 }, { x: 500, y: 500 }, false, history.state);
    tool.onMouseUp({ x: 500, y: 500 }, { x: 500, y: 500 }, false, history.state);
    expect(history.canRedo()).toBe(true);
  });
});

describe('autosave pause recovery', () => {
  it('resumes autosave on reset, cancel and next mouse down', () => {
    const spy = vi.spyOn(docStore, 'setAutosavePaused');
    const { history, tool } = setup();
    tool.onMouseDown({ x: 500, y: 500 }, { x: 500, y: 500 }, false, history.state);
    tool.onMouseMove({ x: 600, y: 600 }, { x: 600, y: 600 }, false, history.state);
    expect(spy).toHaveBeenLastCalledWith(true);
    tool.cancel();
    expect(spy).toHaveBeenLastCalledWith(false);
    spy.mockClear();
    tool.onMouseDown({ x: 500, y: 500 }, { x: 500, y: 500 }, false, history.state);
    expect(spy).toHaveBeenCalledWith(false);
    spy.mockRestore();
  });
});

describe('properties panel XY move', () => {
  it('whole-polygon selection moves all vertices even if a vertex was selected', () => {
    const { history, poly } = setup();
    const whole = [{ type: 'polygon' as const, shapeId: poly.id, index: -1, holeIndex: -1 }];
    history.execute(new MoveCommand(whole, 100, 50));
    const moved = history.state.shapes[0];
    expect(moved.outer.map((p) => [p.x, p.y])).toEqual(poly.outer.map((p) => [p.x + 100, p.y + 50]));
  });
});
