import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PolygonTool } from '../../src/tools/polygon';
import type { ToolContext } from '../../src/tools/base';
import { createDefaultState } from '../../src/types';
import type { AppState, Point } from '../../src/types';
import { History } from '../../src/state/history';

// Minimal mock for ToolContext
function makeCtx() {
  const history = new History(createDefaultState());
  const ctx: ToolContext = {
    history,
    getSnapPoint: (p: Point) => p,
    requestRender: vi.fn(),
  };
  return { ctx, history };
}

function click(tool: PolygonTool, x: number, y: number, state: AppState): void {
  const p = { x, y };
  tool.onMouseDown(p, p, false, state);
}

function hover(tool: PolygonTool, x: number, y: number, state: AppState, shift = false): void {
  const p = { x, y };
  tool.onMouseMove(p, p, shift, state);
}

describe('PolygonTool — commit', () => {
  let tool: PolygonTool;
  let state: AppState;
  let history: History;

  beforeEach(() => {
    const m = makeCtx();
    tool = new PolygonTool(m.ctx);
    history = m.history;
    state = history.state;
  });

  it('commit 3 vertices via Enter creates a polygon', () => {
    click(tool, 0, 0, state);
    click(tool, 1000, 0, state);
    click(tool, 500, 1000, state);
    hover(tool, 500, 1000, state);
    tool.onKeyDown('Enter', state);
    expect(history.state.shapes).toHaveLength(1);
  });

  it('commit by clicking near first vertex', () => {
    click(tool, 0, 0, state);
    click(tool, 1000, 0, state);
    click(tool, 500, 1000, state);
    // hover near vertex[0] (same point → willClose=true)
    hover(tool, 0, 0, state);
    // now click → should close
    click(tool, 0, 0, state);
    expect(history.state.shapes).toHaveLength(1);
  });

  it('rejects fewer than 3 vertices', () => {
    click(tool, 0, 0, state);
    click(tool, 1000, 0, state);
    tool.onKeyDown('Enter', state);
    expect(history.state.shapes).toHaveLength(0);
  });

  it('produced polygon has integer coordinates', () => {
    click(tool, 0, 0, state);
    click(tool, 1000, 0, state);
    click(tool, 500, 866, state);
    hover(tool, 500, 866, state);
    tool.onKeyDown('Enter', state);
    const poly = history.state.shapes[0];
    expect(poly).toBeDefined();
    for (const p of poly.outer) {
      expect(Number.isInteger(p.x)).toBe(true);
      expect(Number.isInteger(p.y)).toBe(true);
    }
  });

  it('produced polygon is CCW (normalized)', () => {
    // CW input: should be normalized to CCW
    click(tool, 0, 0, state);
    click(tool, 0, 1000, state);    // CW order
    click(tool, 1000, 1000, state);
    hover(tool, 1000, 1000, state);
    tool.onKeyDown('Enter', state);
    const poly = history.state.shapes[0];
    expect(poly).toBeDefined();
    // CCW means signedArea2 >= 0
    const ring = poly.outer;
    let area2 = 0;
    for (let i = 0; i < ring.length; i++) {
      const j = (i + 1) % ring.length;
      area2 += ring[i].x * ring[j].y - ring[j].x * ring[i].y;
    }
    expect(area2).toBeGreaterThanOrEqual(0);
  });

  it('undo removes polygon', () => {
    click(tool, 0, 0, state);
    click(tool, 1000, 0, state);
    click(tool, 500, 1000, state);
    hover(tool, 500, 1000, state);
    tool.onKeyDown('Enter', state);
    expect(history.state.shapes).toHaveLength(1);
    history.undo();
    expect(history.state.shapes).toHaveLength(0);
  });
});

describe('PolygonTool — Backspace / cancel', () => {
  let tool: PolygonTool;
  let state: AppState;

  beforeEach(() => {
    const m = makeCtx();
    tool = new PolygonTool(m.ctx);
    state = m.history.state;
  });

  it('Backspace removes the last vertex', () => {
    click(tool, 0, 0, state);
    click(tool, 1000, 0, state);
    click(tool, 500, 1000, state);
    expect(tool.isDrawing()).toBe(true);
    tool.onKeyDown('Backspace', state);
    // 2 vertices remain; Enter is a no-op (< 3 vertices), not a cancel
    expect((tool as any).vertices).toHaveLength(2);
    tool.onKeyDown('Enter', state);
    expect((tool as any).vertices).toHaveLength(2);
  });

  it('Escape cancels drawing', () => {
    click(tool, 0, 0, state);
    click(tool, 1000, 0, state);
    tool.cancel();
    expect(tool.isDrawing()).toBe(false);
  });

  it('isDrawing returns false before any click', () => {
    expect(tool.isDrawing()).toBe(false);
  });

  it('isDrawing returns true after first click', () => {
    click(tool, 0, 0, state);
    expect(tool.isDrawing()).toBe(true);
  });
});

describe('PolygonTool — angle snap', () => {
  let tool: PolygonTool;
  let state: AppState;
  let history: History;

  beforeEach(() => {
    const m = makeCtx();
    tool = new PolygonTool(m.ctx);
    history = m.history;
    state = history.state;
  });

  it('Shift constrains angle to 15° multiples (horizontal)', () => {
    click(tool, 0, 0, state);
    // Move to roughly 30° angle with Shift
    const to = { x: 866, y: 600 }; // ~34.7°
    tool.onMouseMove(to, to, true, state);
    const draft = tool.getDraft();
    expect(draft).not.toBeNull();
    // The hover point (last in draft.points) should be snapped to 30° or 45°
    const pts = draft!.points;
    const hov = pts[pts.length - 1];
    const angle = Math.atan2(hov.y - 0, hov.x - 0) * (180 / Math.PI);
    expect(Math.round(angle) % 15).toBe(0);
  });
});

describe('PolygonTool — self-intersection detection', () => {
  let tool: PolygonTool;
  let state: AppState;
  let history: History;

  beforeEach(() => {
    const m = makeCtx();
    tool = new PolygonTool(m.ctx);
    history = m.history;
    state = history.state;
  });

  it('rejects a bowtie (self-intersecting) polygon', () => {
    // Bowtie requires 4 clicked vertices: (0,0)→(1000,1000)→(1000,0)→(0,1000)
    // Diagonals (0,0)→(1000,1000) and (1000,0)→(0,1000) cross at (500,500)
    click(tool, 0, 0, state);
    click(tool, 1000, 1000, state);
    click(tool, 1000, 0, state);
    click(tool, 0, 1000, state);  // 4th vertex committed → creates bowtie
    tool.onKeyDown('Enter', state);
    expect(history.state.shapes).toHaveLength(0);
  });

  it('allows a valid convex polygon', () => {
    click(tool, 0, 0, state);
    click(tool, 2000, 0, state);
    click(tool, 2000, 1000, state);
    hover(tool, 0, 1000, state);
    tool.onKeyDown('Enter', state);
    expect(history.state.shapes).toHaveLength(1);
  });
});
