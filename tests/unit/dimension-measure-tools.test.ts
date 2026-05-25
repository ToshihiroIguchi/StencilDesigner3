import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DimensionTool } from '../../src/tools/dimension';
import { MeasureTool } from '../../src/tools/measure';
import type { ToolContext } from '../../src/tools/base';
import { createDefaultState } from '../../src/types';
import type { AppState, Point } from '../../src/types';
import { History } from '../../src/state/history';

// Minimal mock for ToolContext
function makeCtx() {
  const history = new History(createDefaultState());
  const ctx: ToolContext = {
    history,
    getSnap: (p: Point) => ({ point: p, kind: 'grid' as const }),
    requestRender: vi.fn(),
  };
  return { ctx, history };
}

describe('DimensionTool (Size Tool)', () => {
  let tool: DimensionTool;
  let state: AppState;
  let history: History;

  beforeEach(() => {
    const m = makeCtx();
    tool = new DimensionTool(m.ctx);
    history = m.history;
    state = history.state;
  });

  it('initially in v1 step with no anchors', () => {
    expect(tool.getStep()).toBe('v1');
    expect(tool.getDimDraft()).toBeNull();
  });

  it('first click moves to v2 step and sets anchor1', () => {
    const p1 = { x: 100, y: 200 };
    tool.onMouseDown(p1, p1, false, state);

    expect(tool.getStep()).toBe('v2');
    const draft = tool.getDimDraft();
    expect(draft).not.toBeNull();
    expect(draft!.p1).toEqual(p1);
    expect(draft!.p2).toBeUndefined();
  });

  it('second click moves to offset step and sets anchor2', () => {
    const p1 = { x: 100, y: 200 };
    const p2 = { x: 1100, y: 200 };
    tool.onMouseDown(p1, p1, false, state);
    tool.onMouseDown(p2, p2, false, state);

    expect(tool.getStep()).toBe('offset');
    const draft = tool.getDimDraft();
    expect(draft).not.toBeNull();
    expect(draft!.p1).toEqual(p1);
    expect(draft!.p2).toEqual(p2);
  });

  it('third click creates a dimension, adds it to history, and chains next dimension start', () => {
    const p1 = { x: 100, y: 200 };
    const p2 = { x: 1100, y: 200 };
    const pOffset = { x: 600, y: 800 }; // offset click

    tool.onMouseDown(p1, p1, false, state);
    tool.onMouseDown(p2, p2, false, state);

    // Mock snap point during MouseMove to pOffset
    tool.onMouseMove(pOffset, pOffset, false, state);

    tool.onMouseDown(pOffset, pOffset, false, state);

    // Should create a Dimension
    expect(history.state.dimensions).toHaveLength(1);
    const dim = history.state.dimensions[0];
    expect(dim.kind).toBe('linear-h'); // horizontal dimension since offset Y difference is larger
    expect(dim.offset).toBe(800); // offset matches click Y

    // Should chain the next dimension start (anchor1 = previous anchor2)
    expect(tool.getStep()).toBe('v2');
    const draft = tool.getDimDraft();
    expect(draft).not.toBeNull();
    expect(draft!.p1).toEqual(p2); // next p1 is the previous p2
  });

  it('cancel resets all state and step to v1', () => {
    const p1 = { x: 100, y: 200 };
    tool.onMouseDown(p1, p1, false, state);
    expect(tool.getStep()).toBe('v2');

    tool.cancel();
    expect(tool.getStep()).toBe('v1');
    expect(tool.getDimDraft()).toBeNull();
  });
});

describe('MeasureTool (Length Measurement Tool)', () => {
  let tool: MeasureTool;
  let state: AppState;
  let history: History;

  beforeEach(() => {
    const m = makeCtx();
    tool = new MeasureTool(m.ctx);
    history = m.history;
    state = history.state;
  });

  it('initially has no p1 and no measure overlay', () => {
    expect(tool.getP1()).toBeNull();
    expect(tool.getMeasureOverlay()).toBeNull();
  });

  it('MouseDown sets p1', () => {
    const p1 = { x: 500, y: 500 };
    tool.onMouseDown(p1, p1, false, state);

    expect(tool.getP1()).toEqual(p1);
    // Since snap is not yet updated byMouseMove, overlay might be null or snap to p1 depending on order
  });

  it('MouseMove updates snap and getMeasureOverlay returns correct points', () => {
    const p1 = { x: 500, y: 500 };
    const p2 = { x: 1000, y: 500 };

    tool.onMouseDown(p1, p1, false, state);
    tool.onMouseMove(p2, p2, false, state);

    const overlay = tool.getMeasureOverlay();
    expect(overlay).not.toBeNull();
    expect(overlay!.p1).toEqual(p1);
    expect(overlay!.p2).toEqual(p2);
  });

  it('consecutive MouseDown resets p1 to the newly clicked point', () => {
    const p1 = { x: 500, y: 500 };
    const p2 = { x: 1000, y: 500 };
    const p3 = { x: 1200, y: 800 };

    tool.onMouseDown(p1, p1, false, state);
    tool.onMouseMove(p2, p2, false, state);
    expect(tool.getP1()).toEqual(p1);

    // Second click
    tool.onMouseDown(p3, p3, false, state);
    expect(tool.getP1()).toEqual(p3);
  });

  it('cancel resets p1 and clears measure overlay', () => {
    const p1 = { x: 500, y: 500 };
    tool.onMouseDown(p1, p1, false, state);
    expect(tool.getP1()).toEqual(p1);

    tool.cancel();
    expect(tool.getP1()).toBeNull();
    expect(tool.getMeasureOverlay()).toBeNull();
  });
});
