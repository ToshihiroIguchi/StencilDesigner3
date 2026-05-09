import type { AppState, Command, Selection, Polygon, Ring, Layer, Dimension } from '../types';
import { defaultLayers } from '../types';
import { addShape, moveShapes, copyShapes, deleteShapes, arrayCopyShapes } from '../core/transform';
import { union, difference } from '../core/boolean';
import { normalize, normalizeAll } from '../normalize';

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

// ─── Fillet (single vertex) ───────────────────────────────────────────────────

export class FilletCommand implements Command {
  private originalShape: Polygon;
  private newShape: Polygon;

  constructor(originalShape: Polygon, holeIndex: number, newRing: Ring) {
    this.originalShape = originalShape;
    if (holeIndex < 0) {
      this.newShape = normalize({ ...originalShape, outer: newRing });
    } else {
      const newHoles = originalShape.holes.map((h, i) => (i === holeIndex ? newRing : h));
      this.newShape = normalize({ ...originalShape, holes: newHoles });
    }
  }

  do(state: AppState): AppState {
    return {
      ...state,
      shapes: state.shapes.map((s) => (s.id === this.originalShape.id ? this.newShape : s)),
    };
  }

  undo(state: AppState): AppState {
    return {
      ...state,
      shapes: state.shapes.map((s) => (s.id === this.newShape.id ? this.originalShape : s)),
    };
  }
}

// ─── Fillet All Corners ───────────────────────────────────────────────────────

export class FilletAllCommand implements Command {
  constructor(
    private readonly before: Polygon[],
    private readonly after: Polygon[],
  ) {}

  do(state: AppState): AppState {
    const map = new Map(this.after.map((s) => [s.id, s]));
    return { ...state, shapes: state.shapes.map((s) => map.get(s.id) ?? s) };
  }

  undo(state: AppState): AppState {
    const map = new Map(this.before.map((s) => [s.id, s]));
    return { ...state, shapes: state.shapes.map((s) => map.get(s.id) ?? s) };
  }
}

// ─── Resize ──────────────────────────────────────────────────────────────────

export class ResizeCommand implements Command {
  constructor(
    private readonly before: Polygon,
    private readonly after: Polygon,
  ) {}
  do(state: AppState): AppState {
    return { ...state, shapes: state.shapes.map((s) => s.id === this.before.id ? this.after : s) };
  }
  undo(state: AppState): AppState {
    return { ...state, shapes: state.shapes.map((s) => s.id === this.after.id ? this.before : s) };
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

// ─── Add Layer ───────────────────────────────────────────────────────────────
export class AddLayerCommand implements Command {
  constructor(private layer: Layer) {}
  do(state: AppState): AppState {
    if (state.layers.some((l) => l.name === this.layer.name)) return state;
    return { ...state, layers: [...state.layers, this.layer] };
  }
  undo(state: AppState): AppState {
    return { ...state, layers: state.layers.filter((l) => l.name !== this.layer.name) };
  }
}

// ─── Delete Layer ─────────────────────────────────────────────────────────────
export class DeleteLayerCommand implements Command {
  private savedLayer: Layer | null = null;
  private affectedShapes: Polygon[] = [];
  constructor(private layerName: string, private mode: 'move' | 'delete', private moveTo?: string) {}
  do(state: AppState): AppState {
    if (state.layers.length <= 1) return state;
    this.savedLayer = state.layers.find((l) => l.name === this.layerName) ?? null;
    if (!this.savedLayer) return state;
    this.affectedShapes = state.shapes.filter((s) => s.layer === this.layerName);
    const newLayers = state.layers.filter((l) => l.name !== this.layerName);
    const newShapes =
      this.mode === 'move' && this.moveTo
        ? state.shapes.map((s) => (s.layer === this.layerName ? { ...s, layer: this.moveTo! } : s))
        : state.shapes.filter((s) => s.layer !== this.layerName);
    const newActive =
      state.activeLayerName === this.layerName ? newLayers[0].name : state.activeLayerName;
    return { ...state, layers: newLayers, shapes: newShapes, activeLayerName: newActive, selection: [] };
  }
  undo(state: AppState): AppState {
    if (!this.savedLayer) return state;
    const saved = this.savedLayer;
    const ids = new Set(this.affectedShapes.map((s) => s.id));
    let restoredShapes: Polygon[];
    if (this.mode === 'move' && this.moveTo) {
      restoredShapes = state.shapes.map((s) => (ids.has(s.id) ? { ...s, layer: this.layerName } : s));
    } else {
      restoredShapes = normalizeAll([...state.shapes, ...this.affectedShapes]);
    }
    return { ...state, layers: [...state.layers, saved], shapes: restoredShapes };
  }
}

// ─── Rename Layer ─────────────────────────────────────────────────────────────
export class RenameLayerCommand implements Command {
  constructor(private oldName: string, private newName: string) {}
  do(state: AppState): AppState {
    if (state.layers.some((l) => l.name === this.newName)) return state;
    return {
      ...state,
      layers: state.layers.map((l) => (l.name === this.oldName ? { ...l, name: this.newName } : l)),
      shapes: state.shapes.map((s) => (s.layer === this.oldName ? { ...s, layer: this.newName } : s)),
      activeLayerName: state.activeLayerName === this.oldName ? this.newName : state.activeLayerName,
    };
  }
  undo(state: AppState): AppState {
    return {
      ...state,
      layers: state.layers.map((l) => (l.name === this.newName ? { ...l, name: this.oldName } : l)),
      shapes: state.shapes.map((s) => (s.layer === this.newName ? { ...s, layer: this.oldName } : s)),
      activeLayerName: state.activeLayerName === this.newName ? this.oldName : state.activeLayerName,
    };
  }
}

// ─── Update Layer Style ───────────────────────────────────────────────────────
type LayerStylePatch = Partial<Pick<Layer, 'color' | 'linetype' | 'lineweight' | 'plot' | 'isAperture'>>;
export class UpdateLayerStyleCommand implements Command {
  private before: Layer | null = null;
  constructor(private layerName: string, private patch: LayerStylePatch) {}
  do(state: AppState): AppState {
    const layer = state.layers.find((l) => l.name === this.layerName);
    if (!layer) return state;
    this.before = { ...layer };
    return {
      ...state,
      layers: state.layers.map((l) => (l.name === this.layerName ? { ...l, ...this.patch } : l)),
    };
  }
  undo(state: AppState): AppState {
    if (!this.before) return state;
    const before = this.before;
    return {
      ...state,
      layers: state.layers.map((l) => (l.name === this.layerName ? before : l)),
    };
  }
}

// ─── Dimensions ───────────────────────────────────────────────────────────────

const DIM_LAYER_TEMPLATE = defaultLayers().find((l) => l.name === 'DIMENSIONS')!;

export class AddDimensionCommand implements Command {
  constructor(private dim: Dimension) {}
  do(state: AppState): AppState {
    // Auto-create DIMENSIONS layer if missing (not undone on undo — intentional)
    const layers = state.layers.some((l) => l.name === 'DIMENSIONS')
      ? state.layers
      : [...state.layers, { ...DIM_LAYER_TEMPLATE }];
    return { ...state, layers, dimensions: [...state.dimensions, this.dim] };
  }
  undo(state: AppState): AppState {
    return { ...state, dimensions: state.dimensions.filter((d) => d.id !== this.dim.id) };
  }
}

export class DeleteDimensionCommand implements Command {
  private saved: Dimension | null = null;
  constructor(private id: string) {}
  do(state: AppState): AppState {
    this.saved = state.dimensions.find((d) => d.id === this.id) ?? null;
    return { ...state, dimensions: state.dimensions.filter((d) => d.id !== this.id) };
  }
  undo(state: AppState): AppState {
    if (!this.saved) return state;
    return { ...state, dimensions: [...state.dimensions, this.saved] };
  }
}

// ─── Move Shapes To Layer ─────────────────────────────────────────────────────
export class MoveShapesToLayerCommand implements Command {
  private originals: Map<string, string> = new Map();
  constructor(private selection: Selection[], private targetLayer: string) {}
  do(state: AppState): AppState {
    const ids = new Set(this.selection.map((s) => s.shapeId));
    this.originals = new Map(
      state.shapes.filter((s) => ids.has(s.id)).map((s) => [s.id, s.layer])
    );
    return { ...state, shapes: state.shapes.map((s) => (ids.has(s.id) ? { ...s, layer: this.targetLayer } : s)) };
  }
  undo(state: AppState): AppState {
    const map = this.originals;
    return { ...state, shapes: state.shapes.map((s) => (map.has(s.id) ? { ...s, layer: map.get(s.id)! } : s)) };
  }
}
