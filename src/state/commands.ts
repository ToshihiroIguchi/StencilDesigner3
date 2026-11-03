import type { AppState, Command, Selection, Polygon, Ring, Layer, Dimension, DimensionAnchor, Point, Annotation } from '../types';
import { DIMENSIONS_LAYER } from '../types';
import { addShape, moveShapes, deleteShapes, arrayCopyShapes } from '../core/transform';
import { union, difference } from '../core/boolean';
import { normalize, normalizeAll } from '../normalize';
import { resolveAnchor, resolveEdge, resolveDimension } from '../core/dimension-resolve';
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

    const updatedAnchor = (a: DimensionAnchor): DimensionAnchor => {
      if (a.kind === 'free') return a;
      if (!refersRemoved(a)) return a;
      // Resolve the live point (vertex uses vertexId; edge uses t-interpolation)
      const live = resolveAnchor(a, shapesBefore);
      return { ...a, cachedPoint: live ?? a.cachedPoint };
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
      frozenAnchor1 = updatedAnchor(dim.anchor1);
      frozenAnchor2 = updatedAnchor(dim.anchor2);
    }

    return { ...dim, anchor1: frozenAnchor1, anchor2: frozenAnchor2, frozen: true };
  });
}

/**
 * After a shape edit (fillet), freeze dimensions whose anchors can no longer be
 * resolved against the new shapes, refreshing every cachedPoint from the live
 * (pre-edit) positions so a frozen dimension does not show stale points.
 */
function freezeUnresolvableDims(
  dims: Dimension[],
  shapesBefore: Polygon[],
  shapesAfter: Polygon[],
): Dimension[] {
  const allIds = new Set(shapesBefore.map((s) => s.id));
  return dims.map((dim) => {
    if (dim.frozen) return dim;
    if (!resolveDimension(dim, shapesAfter).frozen) return dim;
    return freezeDimsForRemovedShapes([dim], shapesBefore, allIds)[0];
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

// ─── Import Batch (atomic shapes & layers addition) ──────────────────────────

export class ImportBatchCommand implements Command {
  private addedShapeIds: Set<string>;
  private actuallyAddedLayers: Layer[] = [];

  private addedAnnotationIds: Set<string>;

  constructor(
    private newLayers: Layer[],
    private polygons: Polygon[],
    private annotations: Annotation[] = [],
  ) {
    this.addedShapeIds = new Set(polygons.map((p) => p.id));
    this.addedAnnotationIds = new Set(annotations.map((a) => a.id));
  }

  do(state: AppState): AppState {
    const existingLayerNames = new Set(state.layers.map((l) => l.name));
    this.actuallyAddedLayers = this.newLayers.filter((l) => !existingLayerNames.has(l.name));

    let shapes = state.shapes;
    for (const p of this.polygons) {
      shapes = addShape(shapes, p);
    }

    return {
      ...state,
      layers: [...state.layers, ...this.actuallyAddedLayers],
      shapes,
      annotations: [...state.annotations, ...this.annotations],
      selection: [],
    };
  }

  undo(state: AppState): AppState {
    const addedLayerNames = new Set(this.actuallyAddedLayers.map((l) => l.name));
    const shapes = state.shapes.filter((s) => !this.addedShapeIds.has(s.id));
    const annotations = state.annotations.filter((a) => !this.addedAnnotationIds.has(a.id));
    let layers = state.layers.filter((l) => !addedLayerNames.has(l.name));
    if (layers.length === 0) {
      layers = [{ name: '0', color: '#ffffff', linetype: 'CONTINUOUS', lineweight: -1, visible: true, locked: false, plot: true, isAperture: true }];
    }
    const activeLayerName = layers.some((l) => l.name === state.activeLayerName) ? state.activeLayerName : layers[0].name;

    return {
      ...state,
      layers,
      activeLayerName,
      shapes,
      annotations,
      selection: [],
    };
  }
}


// ─── Move ────────────────────────────────────────────────────────────────────

function moveDimensions(
  dimensions: Dimension[],
  selection: Selection[],
  movedShapeIds: Set<string>,
  dx: number,
  dy: number,
): Dimension[] {
  const selectedDimIds = new Set(
    selection.filter((s) => s.type === 'dimension').map((s) => s.shapeId),
  );

  return dimensions.map((dim) => {
    const isSelected = selectedDimIds.has(dim.id);
    const anchor1Moves =
      (dim.anchor1.kind === 'vertex' || dim.anchor1.kind === 'edge') &&
      movedShapeIds.has(dim.anchor1.shapeId);
    const anchor2Moves =
      (dim.anchor2.kind === 'vertex' || dim.anchor2.kind === 'edge') &&
      movedShapeIds.has(dim.anchor2.shapeId);
    const bothAnchorsMoveWithShapes = anchor1Moves && anchor2Moves;

    if (!isSelected && !bothAnchorsMoveWithShapes) {
      return dim;
    }

    let nextOffset = dim.offset;
    if (dim.kind === 'linear-h') {
      nextOffset += dy;
    } else if (dim.kind === 'linear-v') {
      nextOffset += dx;
    }

    const translateAnchor = (a: DimensionAnchor, movesWithShape: boolean): DimensionAnchor => {
      if (a.kind === 'free') {
        return isSelected
          ? { ...a, point: { x: a.point.x + dx, y: a.point.y + dy } }
          : a;
      }
      if (movesWithShape) {
        return {
          ...a,
          cachedPoint: { x: a.cachedPoint.x + dx, y: a.cachedPoint.y + dy },
        };
      }
      if (isSelected) {
        return {
          kind: 'free',
          point: { x: a.cachedPoint.x + dx, y: a.cachedPoint.y + dy },
        };
      }
      return a;
    };

    return {
      ...dim,
      offset: nextOffset,
      anchor1: translateAnchor(dim.anchor1, anchor1Moves),
      anchor2: translateAnchor(dim.anchor2, anchor2Moves),
    };
  });
}

export class MoveCommand implements Command {
  /** Original dimension objects that the move changed, keyed by id (restored verbatim on undo). */
  private changedDimsBefore = new Map<string, Dimension>();
  constructor(
    private selection: Selection[],
    private dx: number,
    private dy: number
  ) {}
  do(state: AppState): AppState {
    const movedShapeIds = new Set(
      this.selection
        .filter((s) => s.type === 'polygon' || s.type === 'vertex' || s.type === 'edge')
        .map((s) => s.shapeId),
    );
    const selAnnIds = new Set(
      this.selection.filter((s) => s.type === 'annotation').map((s) => s.shapeId),
    );
    const newAnnotations = selAnnIds.size > 0
      ? state.annotations.map((a) => (selAnnIds.has(a.id) ? { ...a, origin: { x: a.origin.x + this.dx, y: a.origin.y + this.dy } } : a))
      : state.annotations;

    const movedDims = moveDimensions(state.dimensions, this.selection, movedShapeIds, this.dx, this.dy);
    this.changedDimsBefore = new Map();
    state.dimensions.forEach((d, i) => {
      if (movedDims[i] !== d) this.changedDimsBefore.set(d.id, d);
    });

    return {
      ...state,
      shapes: moveShapes(state.shapes, this.selection, this.dx, this.dy),
      dimensions: movedDims,
      annotations: newAnnotations,
      selection: this.selection,
    };
  }
  undo(state: AppState): AppState {
    const selAnnIds = new Set(
      this.selection.filter((s) => s.type === 'annotation').map((s) => s.shapeId),
    );
    const restoredAnnotations = selAnnIds.size > 0
      ? state.annotations.map((a) => (selAnnIds.has(a.id) ? { ...a, origin: { x: a.origin.x - this.dx, y: a.origin.y - this.dy } } : a))
      : state.annotations;

    return {
      ...state,
      shapes: moveShapes(state.shapes, this.selection, -this.dx, -this.dy),
      dimensions: state.dimensions.map((d) => this.changedDimsBefore.get(d.id) ?? d),
      annotations: restoredAnnotations,
      selection: this.selection,
    };
  }
}

// ─── Duplicate (Copy/Array) ──────────────────────────────────────────────────

export class DuplicateCommand implements Command {
  private copiedIds: string[] = [];
  private copies: Polygon[] | null = null;
  constructor(
    private selection: Selection[],
    private nx: number,
    private ny: number,
    private pitchX: number,
    private pitchY: number
  ) {}
  do(state: AppState): AppState {
    if (this.copies === null) {
      // Compute once so redo reuses the same shape ids.
      const before = new Set(state.shapes.map((s) => s.id));
      const nextShapes = arrayCopyShapes(state.shapes, this.selection, this.nx, this.ny, this.pitchX, this.pitchY);
      this.copies = nextShapes.filter((s) => !before.has(s.id));
      this.copiedIds = this.copies.map((s) => s.id);
      return { ...state, shapes: nextShapes, selection: this.selection };
    }
    return { ...state, shapes: [...state.shapes, ...this.copies], selection: this.selection };
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
  private result: Polygon[] | null = null;
  private applied = false;

  constructor(private selection: Selection[]) {}

  do(state: AppState): AppState {
    const ids = new Set(this.selection.map((s) => s.shapeId));
    const targets = state.shapes.filter((s) => ids.has(s.id));
    if (targets.length < 2) {
      this.applied = false;
      return state;
    }

    this.applied = true;
    this.originalShapes = targets;
    this.dimsBefore = state.dimensions;
    // Compute once so redo reuses the same shape ids.
    if (this.result === null) this.result = union(targets);
    const result = this.result;
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
    if (!this.applied) return state;
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
  private result: Polygon[] | null = null;

  constructor(private selectionA: Selection, private selectionB: Selection) {}

  do(state: AppState): AppState {
    const a = state.shapes.find((s) => s.id === this.selectionA.shapeId);
    const b = state.shapes.find((s) => s.id === this.selectionB.shapeId);
    if (!a || !b) {
      this.originalA = null;
      this.originalB = null;
      return state;
    }

    this.originalA = a;
    this.originalB = b;
    this.dimsBefore = state.dimensions;
    // Compute once so redo reuses the same shape ids.
    if (this.result === null) this.result = difference(a, b);
    const result = this.result;
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
  private dimsBefore: Dimension[] | null = null;

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
    const shapes = state.shapes.map((s) => (s.id === this.originalShape.id ? this.newShape : s));
    this.dimsBefore = state.dimensions;
    return {
      ...state,
      shapes,
      dimensions: freezeUnresolvableDims(state.dimensions, state.shapes, shapes),
    };
  }

  undo(state: AppState): AppState {
    return {
      ...state,
      shapes: state.shapes.map((s) => (s.id === this.newShape.id ? this.originalShape : s)),
      dimensions: this.dimsBefore ?? state.dimensions,
    };
  }
}

// ─── Fillet All Corners ───────────────────────────────────────────────────────

export class FilletAllCommand implements Command {
  private dimsBefore: Dimension[] | null = null;

  constructor(
    private readonly before: Polygon[],
    private readonly after: Polygon[],
  ) {}

  do(state: AppState): AppState {
    const map = new Map(this.after.map((s) => [s.id, s]));
    const shapes = state.shapes.map((s) => map.get(s.id) ?? s);
    this.dimsBefore = state.dimensions;
    return {
      ...state,
      shapes,
      dimensions: freezeUnresolvableDims(state.dimensions, state.shapes, shapes),
    };
  }

  undo(state: AppState): AppState {
    const map = new Map(this.before.map((s) => [s.id, s]));
    return {
      ...state,
      shapes: state.shapes.map((s) => map.get(s.id) ?? s),
      dimensions: this.dimsBefore ?? state.dimensions,
    };
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
  private applied = false;
  constructor(private layer: Layer) {}
  do(state: AppState): AppState {
    this.applied = !state.layers.some((l) => l.name === this.layer.name);
    if (!this.applied) return state;
    return { ...state, layers: [...state.layers, this.layer] };
  }
  undo(state: AppState): AppState {
    if (!this.applied) return state;
    return { ...state, layers: state.layers.filter((l) => l.name !== this.layer.name) };
  }
}

// ─── Delete Layer ─────────────────────────────────────────────────────────────
export class DeleteLayerCommand implements Command {
  private savedLayer: Layer | null = null;
  private savedIndex = -1;
  private savedWasActive = false;
  private savedActiveName = '';
  private savedSelection: AppState['selection'] = [];
  private affectedShapes: Polygon[] = [];
  private savedDimensions: Dimension[] = [];
  private savedAnnotations: Annotation[] = [];
  constructor(private layerName: string, private mode: 'move' | 'delete', private moveTo?: string) {}
  do(state: AppState): AppState {
    if (state.layers.length <= 1) return state;
    this.savedIndex = state.layers.findIndex((l) => l.name === this.layerName);
    if (this.savedIndex < 0) return state;
    this.savedLayer = state.layers[this.savedIndex];
    this.savedWasActive = state.activeLayerName === this.layerName;
    this.savedActiveName = state.activeLayerName;
    this.savedSelection = state.selection;
    this.affectedShapes = state.shapes.filter((s) => s.layer === this.layerName);
    this.savedDimensions = state.dimensions;
    this.savedAnnotations = state.annotations;

    const newLayers = state.layers.filter((l) => l.name !== this.layerName);
    const newShapes =
      this.mode === 'move' && this.moveTo
        ? state.shapes.map((s) => (s.layer === this.layerName ? { ...s, layer: this.moveTo! } : s))
        : state.shapes.filter((s) => s.layer !== this.layerName);

    let newDims: Dimension[];
    if (this.mode === 'move' && this.moveTo) {
      newDims = state.dimensions.map((d) => (d.layer === this.layerName ? { ...d, layer: this.moveTo! } : d));
    } else {
      const removedIds = new Set(this.affectedShapes.map((s) => s.id));
      const remainingDims = state.dimensions.filter((d) => d.layer !== this.layerName);
      newDims = freezeDimsForRemovedShapes(remainingDims, state.shapes, removedIds);
    }

    const newAnnotations =
      this.mode === 'move' && this.moveTo
        ? state.annotations.map((a) => (a.layer === this.layerName ? { ...a, layer: this.moveTo! } : a))
        : state.annotations.filter((a) => a.layer !== this.layerName);

    const newActive = this.savedWasActive ? pickFallbackActiveLayer(newLayers) : state.activeLayerName;
    return {
      ...state,
      layers: newLayers,
      shapes: newShapes,
      dimensions: newDims,
      annotations: newAnnotations,
      activeLayerName: newActive,
      selection: [],
    };
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
    const restoredLayers = [...state.layers];
    restoredLayers.splice(Math.min(this.savedIndex, restoredLayers.length), 0, saved);
    return {
      ...state,
      layers: restoredLayers,
      shapes: restoredShapes,
      dimensions: this.savedDimensions,
      annotations: this.savedAnnotations,
      activeLayerName: this.savedWasActive ? this.savedActiveName : state.activeLayerName,
      selection: this.savedSelection,
    };
  }
}

/** First visible non-DIMENSIONS layer, else first non-DIMENSIONS, else the first layer. */
function pickFallbackActiveLayer(layers: Layer[]): string {
  const candidates = layers.filter((l) => l.name !== 'DIMENSIONS');
  return (candidates.find((l) => l.visible) ?? candidates[0] ?? layers[0]).name;
}

// ─── Rename Layer ─────────────────────────────────────────────────────────────
export class RenameLayerCommand implements Command {
  private applied = false;
  constructor(private oldName: string, private newName: string) {}
  do(state: AppState): AppState {
    this.applied = !state.layers.some((l) => l.name === this.newName);
    if (!this.applied) return state;
    return {
      ...state,
      layers: state.layers.map((l) => (l.name === this.oldName ? { ...l, name: this.newName } : l)),
      shapes: state.shapes.map((s) => (s.layer === this.oldName ? { ...s, layer: this.newName } : s)),
      dimensions: state.dimensions.map((d) => (d.layer === this.oldName ? { ...d, layer: this.newName } : d)),
      annotations: state.annotations.map((a) => (a.layer === this.oldName ? { ...a, layer: this.newName } : a)),
      activeLayerName: state.activeLayerName === this.oldName ? this.newName : state.activeLayerName,
    };
  }
  undo(state: AppState): AppState {
    if (!this.applied) return state;
    return {
      ...state,
      layers: state.layers.map((l) => (l.name === this.newName ? { ...l, name: this.oldName } : l)),
      shapes: state.shapes.map((s) => (s.layer === this.newName ? { ...s, layer: this.oldName } : s)),
      dimensions: state.dimensions.map((d) => (d.layer === this.newName ? { ...d, layer: this.oldName } : d)),
      annotations: state.annotations.map((a) => (a.layer === this.newName ? { ...a, layer: this.oldName } : a)),
      activeLayerName: state.activeLayerName === this.newName ? this.oldName : state.activeLayerName,
    };
  }
}

// ─── Update Layer Style ───────────────────────────────────────────────────────
type LayerStylePatch = Partial<Pick<Layer, 'color' | 'linetype' | 'lineweight' | 'plot' | 'isAperture' | 'visible' | 'locked'>>;
export class UpdateLayerStyleCommand implements Command {
  private before: Layer | null = null;
  private savedActiveName: string | null = null;
  constructor(private layerName: string, private patch: LayerStylePatch) {}
  do(state: AppState): AppState {
    const layer = state.layers.find((l) => l.name === this.layerName);
    if (!layer) return state;
    this.before = { ...layer };
    this.savedActiveName = null;
    const layers = state.layers.map((l) => (l.name === this.layerName ? { ...l, ...this.patch } : l));
    let activeLayerName = state.activeLayerName;
    if (this.patch.visible === false && activeLayerName === this.layerName) {
      // Never leave the active layer hidden: move to another visible layer if one exists.
      const other = layers.find((l) => l.visible && l.name !== this.layerName && l.name !== 'DIMENSIONS');
      if (other) {
        this.savedActiveName = activeLayerName;
        activeLayerName = other.name;
      }
    }
    if (this.patch.locked === true && activeLayerName === this.layerName) {
      // Never leave a locked layer as the drawing target.
      const other = layers.find((l) => l.visible && !l.locked && l.name !== this.layerName && l.name !== 'DIMENSIONS');
      if (other) {
        this.savedActiveName = activeLayerName;
        activeLayerName = other.name;
      }
    }
    return { ...state, layers, activeLayerName };
  }
  undo(state: AppState): AppState {
    if (!this.before) return state;
    const before = this.before;
    return {
      ...state,
      layers: state.layers.map((l) => (l.name === this.layerName ? before : l)),
      activeLayerName: this.savedActiveName ?? state.activeLayerName,
    };
  }
}

// ─── Dimensions ───────────────────────────────────────────────────────────────

const DIM_LAYER_TEMPLATE = DIMENSIONS_LAYER;

export class AddDimensionCommand implements Command {
  private layerWasCreated = false;
  constructor(private dim: Dimension) {}
  do(state: AppState): AppState {
    this.layerWasCreated = !state.layers.some((l) => l.name === 'DIMENSIONS');
    const layers = this.layerWasCreated
      ? [...state.layers, { ...DIM_LAYER_TEMPLATE }]
      : state.layers;
    return { ...state, layers, dimensions: [...state.dimensions, this.dim] };
  }
  undo(state: AppState): AppState {
    const nextDims = state.dimensions.filter((d) => d.id !== this.dim.id);
    const stillReferenced =
      nextDims.some((d) => d.layer === 'DIMENSIONS') ||
      state.annotations.some((a) => a.layer === 'DIMENSIONS');
    const layers = (this.layerWasCreated && !stillReferenced)
      ? state.layers.filter((l) => l.name !== 'DIMENSIONS')
      : state.layers;
    return { ...state, layers, dimensions: nextDims };
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
  private layerWasCreated = false;
  constructor(private ann: Annotation) {}
  do(state: AppState): AppState {
    this.layerWasCreated = !state.layers.some((l) => l.name === 'DIMENSIONS');
    const layers = this.layerWasCreated
      ? [...state.layers, { ...DIM_LAYER_TEMPLATE }]
      : state.layers;
    return { ...state, layers, annotations: [...state.annotations, this.ann] };
  }
  undo(state: AppState): AppState {
    const nextAnns = state.annotations.filter((a) => a.id !== this.ann.id);
    const stillReferenced =
      state.dimensions.some((d) => d.layer === 'DIMENSIONS') ||
      nextAnns.some((a) => a.layer === 'DIMENSIONS');
    const layers = (this.layerWasCreated && !stillReferenced)
      ? state.layers.filter((l) => l.name !== 'DIMENSIONS')
      : state.layers;
    return { ...state, layers, annotations: nextAnns };
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

export class CompoundCommand implements Command {
  constructor(private readonly cmds: Command[]) {}
  do(state: AppState): AppState {
    return this.cmds.reduce((s, c) => c.do(s), state);
  }
  undo(state: AppState): AppState {
    let s = state;
    for (let i = this.cmds.length - 1; i >= 0; i--) s = this.cmds[i].undo(s);
    return s;
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
