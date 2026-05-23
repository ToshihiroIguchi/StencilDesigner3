import type { AppState, Command, Selection, Polygon, Ring, Layer, Dimension, DimensionAnchor, Point, Annotation } from '../types';
import { DIMENSIONS_LAYER } from '../types';
import { addShape, moveShapes, deleteShapes, arrayCopyShapes } from '../core/transform';
import { union, difference } from '../core/boolean';
import { normalize, normalizeAll } from '../normalize';
import { resolveAnchor, resolveEdge } from '../core/dimension-resolve';
import { centerlineEndpoints } from '../core/centerline-geometry';

/**
 * Freeze any dimensions that reference shapes being removed.
 * Resolves live positions from `shapesBefore` and stores as cachedPoint.
 */
function freezeDimsForRemovedShapes(
  dims: Dimension[],
  shapesBefore: Polygon[],
  removedIds: Set<string>,
): Dimension[] {
  return dims.map((dim) => {
    const refersRemoved = (a: DimensionAnchor) =>
      (a.kind === 'vertex' || a.kind === 'edge') && removedIds.has(a.shapeId);
    if (!refersRemoved(dim.anchor1) && !refersRemoved(dim.anchor2)) return dim;

    const updatedAnchor = (a: DimensionAnchor, otherEndpoint: Point): DimensionAnchor => {
      if (a.kind === 'free') return a;
      if (!refersRemoved(a)) return a;
      if (a.kind === 'vertex') {
        const live = resolveAnchor(a, shapesBefore);
        return { ...a, cachedPoint: live ?? a.cachedPoint };
      }
      // edge anchor: for centerline, cachedPoint should be the centerline endpoint
      // which is already stored correctly; just ensure we have a good value
      const live = resolveEdge(a, shapesBefore);
      if (live) {
        // midpoint as fallback
        const mid: Point = {
          x: Math.round((live[0].x + live[1].x) / 2),
          y: Math.round((live[0].y + live[1].y) / 2),
        };
        return { ...a, cachedPoint: mid };
      }
      return a;
      void otherEndpoint;
    };

    // For centerline: compute full centerline before freeze so both endpoints are captured
    let frozenAnchor1 = dim.anchor1;
    let frozenAnchor2 = dim.anchor2;
    if (dim.kind === 'centerline') {
      const e1 = resolveEdge(dim.anchor1, shapesBefore);
      const e2 = resolveEdge(dim.anchor2, shapesBefore);
      if (e1 && e2) {
        const cl = centerlineEndpoints(e1, e2);
        if (cl) {
          if (dim.anchor1.kind === 'edge') frozenAnchor1 = { ...dim.anchor1, cachedPoint: cl.p1 };
          if (dim.anchor2.kind === 'edge') frozenAnchor2 = { ...dim.anchor2, cachedPoint: cl.p2 };
        }
      }
    } else {
      const p2 = resolveAnchor(dim.anchor2, shapesBefore) ?? (dim.anchor2.kind !== 'free' ? dim.anchor2.cachedPoint : dim.anchor2.point);
      frozenAnchor1 = updatedAnchor(dim.anchor1, p2);
      const p1 = resolveAnchor(dim.anchor1, shapesBefore) ?? (dim.anchor1.kind !== 'free' ? dim.anchor1.cachedPoint : dim.anchor1.point);
      frozenAnchor2 = updatedAnchor(dim.anchor2, p1);
    }

    return { ...dim, anchor1: frozenAnchor1, anchor2: frozenAnchor2, frozen: true };
  });
}

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

// ─── Add Shapes (multiple in one undo step) ──────────────────────────────────

export class AddShapesCommand implements Command {
  private addedIds: string[];
  constructor(private polygons: Polygon[]) {
    this.addedIds = polygons.map(p => p.id);
  }
  do(state: AppState): AppState {
    let shapes = state.shapes;
    for (const p of this.polygons) shapes = addShape(shapes, p);
    return { ...state, shapes, selection: [] };
  }
  undo(state: AppState): AppState {
    const ids = new Set(this.addedIds);
    return { ...state, shapes: state.shapes.filter(s => !ids.has(s.id)), selection: [] };
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

// ─── Duplicate (Copy/Array) ──────────────────────────────────────────────────

export class DuplicateCommand implements Command {
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

// ─── Delete ──────────────────────────────────────────────────────────────────

export class DeleteCommand implements Command {
  private deletedShapes: Polygon[] = [];
  private dimsBefore: Dimension[] = [];
  private annsBefore: Annotation[] = [];
  constructor(private selection: Selection[]) {}
  do(state: AppState): AppState {
    const shapeIds = new Set(this.selection.filter((s) => s.type !== 'dimension' && s.type !== 'annotation').map((s) => s.shapeId));
    const dimIds = new Set(this.selection.filter((s) => s.type === 'dimension').map((s) => s.shapeId));
    const annIds = new Set(this.selection.filter((s) => s.type === 'annotation').map((s) => s.shapeId));
    this.deletedShapes = state.shapes.filter((s) => shapeIds.has(s.id));
    this.dimsBefore = state.dimensions;
    this.annsBefore = state.annotations;
    let nextDims = freezeDimsForRemovedShapes(state.dimensions, state.shapes, shapeIds);
    nextDims = nextDims.filter((d) => !dimIds.has(d.id));
    return {
      ...state,
      shapes: deleteShapes(state.shapes, this.selection.filter((s) => s.type !== 'dimension' && s.type !== 'annotation')),
      dimensions: nextDims,
      annotations: state.annotations.filter((a) => !annIds.has(a.id)),
      selection: [],
    };
  }
  undo(state: AppState): AppState {
    return {
      ...state,
      shapes: normalizeAll([...state.shapes, ...this.deletedShapes]),
      dimensions: this.dimsBefore,
      annotations: this.annsBefore,
      selection: [],
    };
  }
}

// ─── Paste ───────────────────────────────────────────────────────────────────

export class PasteCommand implements Command {
  private pastedIds: string[];
  constructor(private polygons: Polygon[]) {
    this.pastedIds = polygons.map((p) => p.id);
  }
  do(state: AppState): AppState {
    let shapes = state.shapes;
    for (const p of this.polygons) shapes = addShape(shapes, p);
    const newSel: Selection[] = this.pastedIds.map((id) => ({
      type: 'polygon', shapeId: id, index: -1, holeIndex: -1,
    }));
    return { ...state, shapes, selection: newSel };
  }
  undo(state: AppState): AppState {
    const ids = new Set(this.pastedIds);
    return { ...state, shapes: state.shapes.filter((s) => !ids.has(s.id)), selection: [] };
  }
}


// ─── Boolean Union ───────────────────────────────────────────────────────────

export class UnionCommand implements Command {
  private originalShapes: Polygon[] = [];
  private resultIds: string[] = [];
  private dimsBefore: Dimension[] = [];

  constructor(private selection: Selection[]) {}

  do(state: AppState): AppState {
    const ids = new Set(this.selection.map((s) => s.shapeId));
    const targets = state.shapes.filter((s) => ids.has(s.id));
    if (targets.length < 2) return state;

    this.originalShapes = targets;
    this.dimsBefore = state.dimensions;
    const result = union(targets);
    this.resultIds = result.map((r) => r.id);

    const remaining = state.shapes.filter((s) => !ids.has(s.id));
    const newSel = result.map((r) => ({ type: 'polygon' as const, shapeId: r.id, index: -1, holeIndex: -1 }));
    const frozenDims = freezeDimsForRemovedShapes(state.dimensions, state.shapes, ids);
    return {
      ...state,
      shapes: normalizeAll([...remaining, ...result]),
      dimensions: frozenDims,
      selection: newSel,
    };
  }

  undo(state: AppState): AppState {
    const ids = new Set(this.resultIds);
    const remaining = state.shapes.filter((s) => !ids.has(s.id));
    return {
      ...state,
      shapes: normalizeAll([...remaining, ...this.originalShapes]),
      dimensions: this.dimsBefore,
      selection: [],
    };
  }
}

// ─── Boolean Difference ──────────────────────────────────────────────────────

export class DifferenceCommand implements Command {
  private originalA: Polygon | null = null;
  private originalB: Polygon | null = null;
  private resultIds: string[] = [];
  private dimsBefore: Dimension[] = [];

  constructor(private selectionA: Selection, private selectionB: Selection) {}

  do(state: AppState): AppState {
    const a = state.shapes.find((s) => s.id === this.selectionA.shapeId);
    const b = state.shapes.find((s) => s.id === this.selectionB.shapeId);
    if (!a || !b) return state;

    this.originalA = a;
    this.originalB = b;
    this.dimsBefore = state.dimensions;
    const result = difference(a, b);
    this.resultIds = result.map((r) => r.id);

    const removedIds = new Set([a.id, b.id]);
    const remaining = state.shapes.filter((s) => s.id !== a.id && s.id !== b.id);
    const newSel = result.map((r) => ({ type: 'polygon' as const, shapeId: r.id, index: -1, holeIndex: -1 }));
    const frozenDims = freezeDimsForRemovedShapes(state.dimensions, state.shapes, removedIds);
    return {
      ...state,
      shapes: normalizeAll([...remaining, ...result]),
      dimensions: frozenDims,
      selection: newSel,
    };
  }

  undo(state: AppState): AppState {
    if (!this.originalA || !this.originalB) return state;
    const ids = new Set(this.resultIds);
    const remaining = state.shapes.filter((s) => !ids.has(s.id));
    return {
      ...state,
      shapes: normalizeAll([...remaining, this.originalA, this.originalB]),
      dimensions: this.dimsBefore,
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

const DIM_LAYER_TEMPLATE = DIMENSIONS_LAYER;

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

// ─── Annotations ─────────────────────────────────────────────────────────────

export class AddAnnotationCommand implements Command {
  constructor(private ann: Annotation) {}
  do(state: AppState): AppState {
    const layers = state.layers.some((l) => l.name === 'DIMENSIONS')
      ? state.layers
      : [...state.layers, { ...DIM_LAYER_TEMPLATE }];
    return { ...state, layers, annotations: [...state.annotations, this.ann] };
  }
  undo(state: AppState): AppState {
    return { ...state, annotations: state.annotations.filter((a) => a.id !== this.ann.id) };
  }
}

export class EditAnnotationCommand implements Command {
  private before: Annotation | null = null;
  constructor(private id: string, private patch: Partial<Pick<Annotation, 'text' | 'heightUm' | 'origin' | 'layer'>>) {}
  do(state: AppState): AppState {
    this.before = state.annotations.find((a) => a.id === this.id) ?? null;
    if (!this.before) return state;
    return { ...state, annotations: state.annotations.map((a) => a.id === this.id ? { ...a, ...this.patch } : a) };
  }
  undo(state: AppState): AppState {
    if (!this.before) return state;
    const before = this.before;
    return { ...state, annotations: state.annotations.map((a) => a.id === this.id ? before : a) };
  }
}

// ─── Cut (split polygon by line segment) ─────────────────────────────────────

export class CutCommand implements Command {
  private removedIds: string[];
  private addedIds: string[];
  private dimsBefore: Dimension[] = [];

  constructor(
    private readonly originals: Polygon[],
    private readonly pieces: Polygon[],
  ) {
    this.removedIds = originals.map((p) => p.id);
    this.addedIds = pieces.map((p) => p.id);
  }

  do(state: AppState): AppState {
    this.dimsBefore = state.dimensions;
    const removedSet = new Set(this.removedIds);
    const remaining = state.shapes.filter((s) => !removedSet.has(s.id));
    const frozenDims = freezeDimsForRemovedShapes(state.dimensions, state.shapes, removedSet);
    const newSel: Selection[] = this.addedIds.map((id) => ({
      type: 'polygon', shapeId: id, index: -1, holeIndex: -1,
    }));
    return {
      ...state,
      shapes: normalizeAll([...remaining, ...this.pieces]),
      dimensions: frozenDims,
      selection: newSel,
    };
  }

  undo(state: AppState): AppState {
    const addedSet = new Set(this.addedIds);
    const remaining = state.shapes.filter((s) => !addedSet.has(s.id));
    return {
      ...state,
      shapes: normalizeAll([...remaining, ...this.originals]),
      dimensions: this.dimsBefore,
      selection: [],
    };
  }
}

export class MoveAnnotationCommand implements Command {
  private before: Point | null = null;
  constructor(private id: string, private newOrigin: Point) {}
  do(state: AppState): AppState {
    const ann = state.annotations.find((a) => a.id === this.id);
    if (!ann) return state;
    this.before = ann.origin;
    return { ...state, annotations: state.annotations.map((a) => a.id === this.id ? { ...a, origin: this.newOrigin } : a) };
  }
  undo(state: AppState): AppState {
    if (!this.before) return state;
    const before = this.before;
    return { ...state, annotations: state.annotations.map((a) => a.id === this.id ? { ...a, origin: before } : a) };
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
