import type { AppState, Command, Selection, Polygon } from '../types';
import { addShape, moveShapes, copyShapes, deleteShapes, arrayCopyShapes } from '../core/transform';
import { union, difference } from '../core/boolean';
import { normalizeAll } from '../normalize';

// ─── Add Shape ───────────────────────────────────────────────────────────────

export class AddShapeCommand implements Command {
  private polygon: Polygon;
  constructor(polygon: Polygon) {
    this.polygon = polygon;
  }
  do(state: AppState): AppState {
    return { ...state, shapes: addShape(state.shapes, this.polygon), selection: [] };
  }
  undo(state: AppState): AppState {
    return { ...state, shapes: state.shapes.filter((s) => s.id !== this.polygon.id), selection: [] };
  }
}

// ─── Move ────────────────────────────────────────────────────────────────────

export class MoveCommand implements Command {
  constructor(
    private selection: Selection[],
    private dx: number,
    private dy: number
  ) {}
  do(state: AppState): AppState {
    return {
      ...state,
      shapes: moveShapes(state.shapes, this.selection, this.dx, this.dy),
      selection: this.selection,
    };
  }
  undo(state: AppState): AppState {
    return {
      ...state,
      shapes: moveShapes(state.shapes, this.selection, -this.dx, -this.dy),
      selection: this.selection,
    };
  }
}

// ─── Copy ────────────────────────────────────────────────────────────────────

export class CopyCommand implements Command {
  private copiedIds: string[] = [];
  constructor(
    private selection: Selection[],
    private dx: number,
    private dy: number
  ) {}
  do(state: AppState): AppState {
    const before = new Set(state.shapes.map((s) => s.id));
    const nextShapes = copyShapes(state.shapes, this.selection, this.dx, this.dy);
    this.copiedIds = nextShapes.filter((s) => !before.has(s.id)).map((s) => s.id);
    const newSel: Selection[] = this.copiedIds.map((id) => ({
      type: 'polygon', shapeId: id, index: -1, holeIndex: -1,
    }));
    return { ...state, shapes: nextShapes, selection: newSel };
  }
  undo(state: AppState): AppState {
    const ids = new Set(this.copiedIds);
    return { ...state, shapes: state.shapes.filter((s) => !ids.has(s.id)), selection: [] };
  }
}

// ─── Delete ──────────────────────────────────────────────────────────────────

export class DeleteCommand implements Command {
  private deletedShapes: Polygon[] = [];
  constructor(private selection: Selection[]) {}
  do(state: AppState): AppState {
    const ids = new Set(this.selection.map((s) => s.shapeId));
    this.deletedShapes = state.shapes.filter((s) => ids.has(s.id));
    return { ...state, shapes: deleteShapes(state.shapes, this.selection), selection: [] };
  }
  undo(state: AppState): AppState {
    return { ...state, shapes: normalizeAll([...state.shapes, ...this.deletedShapes]), selection: [] };
  }
}

// ─── Array Copy ──────────────────────────────────────────────────────────────

export class ArrayCopyCommand implements Command {
  private copiedIds: string[] = [];
  constructor(
    private selection: Selection[],
    private nx: number,
    private ny: number,
    private pitchX: number,
    private pitchY: number
  ) {}
  do(state: AppState): AppState {
    const before = new Set(state.shapes.map((s) => s.id));
    const nextShapes = arrayCopyShapes(state.shapes, this.selection, this.nx, this.ny, this.pitchX, this.pitchY);
    this.copiedIds = nextShapes.filter((s) => !before.has(s.id)).map((s) => s.id);
    return { ...state, shapes: nextShapes, selection: this.selection };
  }
  undo(state: AppState): AppState {
    const ids = new Set(this.copiedIds);
    return { ...state, shapes: state.shapes.filter((s) => !ids.has(s.id)), selection: this.selection };
  }
}

// ─── Boolean Union ───────────────────────────────────────────────────────────

export class UnionCommand implements Command {
  private originalShapes: Polygon[] = [];
  private resultIds: string[] = [];

  constructor(private selection: Selection[]) {}

  do(state: AppState): AppState {
    const ids = new Set(this.selection.map((s) => s.shapeId));
    const targets = state.shapes.filter((s) => ids.has(s.id));
    if (targets.length < 2) return state;

    this.originalShapes = targets;
    const result = union(targets);
    this.resultIds = result.map((r) => r.id);

    const remaining = state.shapes.filter((s) => !ids.has(s.id));
    const newSel = result.map((r) => ({ type: 'polygon' as const, shapeId: r.id, index: -1, holeIndex: -1 }));
    return { ...state, shapes: normalizeAll([...remaining, ...result]), selection: newSel };
  }

  undo(state: AppState): AppState {
    const ids = new Set(this.resultIds);
    const remaining = state.shapes.filter((s) => !ids.has(s.id));
    return { ...state, shapes: normalizeAll([...remaining, ...this.originalShapes]), selection: [] };
  }
}

// ─── Boolean Difference ──────────────────────────────────────────────────────

export class DifferenceCommand implements Command {
  private originalA: Polygon | null = null;
  private originalB: Polygon | null = null;
  private resultIds: string[] = [];

  constructor(private selectionA: Selection, private selectionB: Selection) {}

  do(state: AppState): AppState {
    const a = state.shapes.find((s) => s.id === this.selectionA.shapeId);
    const b = state.shapes.find((s) => s.id === this.selectionB.shapeId);
    if (!a || !b) return state;

    this.originalA = a;
    this.originalB = b;
    const result = difference(a, b);
    this.resultIds = result.map((r) => r.id);

    const remaining = state.shapes.filter((s) => s.id !== a.id && s.id !== b.id);
    const newSel = result.map((r) => ({ type: 'polygon' as const, shapeId: r.id, index: -1, holeIndex: -1 }));
    return { ...state, shapes: normalizeAll([...remaining, ...result]), selection: newSel };
  }

  undo(state: AppState): AppState {
    if (!this.originalA || !this.originalB) return state;
    const ids = new Set(this.resultIds);
    const remaining = state.shapes.filter((s) => !ids.has(s.id));
    return {
      ...state,
      shapes: normalizeAll([...remaining, this.originalA, this.originalB]),
      selection: [],
    };
  }
}

// ─── Set Tool ────────────────────────────────────────────────────────────────

export class SetSelectionCommand implements Command {
  constructor(private newSel: Selection[], private prevSel: Selection[]) {}
  do(state: AppState): AppState {
    return { ...state, selection: this.newSel };
  }
  undo(state: AppState): AppState {
    return { ...state, selection: this.prevSel };
  }
}
