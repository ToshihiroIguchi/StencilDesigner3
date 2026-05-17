// All coordinates are integers in micrometers (µm). No floating-point geometry.

export interface Point {
  x: number; // integer µm
  y: number; // integer µm
}

export interface Vertex extends Point {
  id: string; // persistent identity, survives normalize/move/resize
}

/** Closed polygon ring. The last point must NOT equal the first (implicit closure). */
export type Ring = Vertex[];

export interface Polygon {
  id: string;
  outer: Ring;
  holes: Ring[];
  layer: string;
}

export type ToolType =
  | 'select'
  | 'rect'
  | 'circle'
  | 'polygon'
  | 'move'
  | 'copy'
  | 'delete'
  | 'array'
  | 'union'
  | 'difference'
  | 'fillet'
  | 'measure'
  | 'dimension'
  | 'centerline'
  | 'arrow';

export interface Selection {
  type: 'vertex' | 'edge' | 'polygon' | 'dimension';
  shapeId: string; // If type === 'dimension', this is the dimension ID
  /** vertex/edge index within the outer ring (or hole ring if holeIndex >= 0) */
  index: number;
  holeIndex: number; // -1 = outer ring
}

export type LineType = 'CONTINUOUS' | 'DASHED' | 'HIDDEN' | 'CENTER' | 'PHANTOM' | 'DASHDOT';

export interface Layer {
  name: string;        // unique key, DXF group code 8
  color: string;       // CSS color "#RRGGBB"
  linetype: LineType;
  lineweight: number;  // 0.01mm units, -1=default
  visible: boolean;
  locked: boolean;
  plot: boolean;       // DXF export flag
  isAperture: boolean; // true=DRC target+DXF export target (app-specific, not written to DXF)
}

/**
 * Reference to a specific vertex or edge of a polygon ring.
 * Vertex IDs survive translate/resize/normalize. Boolean operations generate new IDs.
 */
export type DimensionAnchor =
  | {
      kind: 'vertex';
      shapeId: string;
      ringIndex: number;   // -1 = outer, 0+ = hole index
      vertexId: string;    // Vertex.id of the referenced vertex
      cachedPoint: Point;  // last resolved position (fallback when shape deleted)
    }
  | {
      kind: 'edge';
      shapeId: string;
      ringIndex: number;
      edgeStartId: string; // Vertex.id of edge start
      edgeEndId: string;   // Vertex.id of edge end
      cachedPoint: Point;  // for centerline: the centerline endpoint; for linear: edge midpoint
    }
  | {
      kind: 'free';
      point: Point;        // absolute world coordinate (no shape ref)
    };

export interface Dimension {
  id: string;
  kind: 'linear-h' | 'linear-v' | 'centerline' | 'arrow';
  anchor1: DimensionAnchor;
  anchor2: DimensionAnchor;
  /** World coordinate of the dimension line.
   *  linear-h: Y coordinate of the horizontal dim line.
   *  linear-v: X coordinate of the vertical dim line.
   *  centerline: unused (always 0). */
  offset: number;
  layer: string;
  /** True when at least one anchor cannot be resolved (shape deleted or boolean consumed). */
  frozen: boolean;
}

export interface AppState {
  shapes: Polygon[];
  activeTool: ToolType;
  selection: Selection[];
  zoom: number; // canvas pixels per µm
  panX: number; // canvas offset in pixels
  panY: number;
  snapEnabled: boolean;
  gridSize: number; // µm
  snapRadius: number; // pixels
  layers: Layer[];
  activeLayerName: string;
  dimensions: Dimension[];
  displayUnit: 'mm' | 'um';
  schemaVersion: number;
}

export interface Command {
  do(state: AppState): AppState;
  undo(state: AppState): AppState;
}

export interface DrcError {
  shapeId: string;
  shapeId2?: string;   // second shape for spacing/overlap errors
  message: string;
  severity: 'error' | 'warning';
  loc?: Point;         // approximate world-coordinate location of the violation
}

// Viewport transform helpers (read-only view, not stored in state)
export interface ViewTransform {
  zoom: number;
  panX: number;
  panY: number;
}

export function canvasToWorld(px: number, py: number, vt: ViewTransform): Point {
  return {
    x: Math.round((px - vt.panX) / vt.zoom),
    y: Math.round((py - vt.panY) / vt.zoom),
  };
}

export function worldToCanvas(wx: number, wy: number, vt: ViewTransform): Point {
  return {
    x: Math.round(wx * vt.zoom + vt.panX),
    y: Math.round(wy * vt.zoom + vt.panY),
  };
}

export function defaultLayers(): Layer[] {
  // Only layer '0' is created by default. All other layers (REGMARK, OUTLINE,
  // DIMENSIONS) are either added on demand or by the user. This keeps the layer
  // panel uncluttered for new documents.
  return [
    { name: '0', color: '#4a9eff', linetype: 'CONTINUOUS', lineweight: -1, visible: true, locked: false, plot: true, isAperture: true },
  ];
}

/** Registration-mark layer definition (not a default — add when needed). */
export const REGMARK_LAYER: Layer = {
  name: 'REGMARK', color: '#ff4444', linetype: 'CONTINUOUS',
  lineweight: -1, visible: true, locked: false, plot: true, isAperture: true,
};

/** Outline/frame layer definition (not a default — add when needed). */
export const OUTLINE_LAYER: Layer = {
  name: 'OUTLINE', color: '#888888', linetype: 'DASHED',
  lineweight: -1, visible: true, locked: false, plot: true, isAperture: false,
};

/** Auto-managed DIMENSIONS layer (injected by AddDimensionCommand). */
export const DIMENSIONS_LAYER: Layer = {
  name: 'DIMENSIONS', color: '#aabbdd', linetype: 'CONTINUOUS',
  lineweight: -1, visible: true, locked: false, plot: false, isAperture: false,
};

export function createDefaultState(): AppState {
  return {
    shapes: [],
    activeTool: 'select',
    selection: [],
    zoom: 0.5,
    panX: 50,
    panY: 50,
    snapEnabled: true,
    gridSize: 1000,
    snapRadius: 8,
    layers: defaultLayers(),
    activeLayerName: '0',
    dimensions: [],
    displayUnit: 'um',
    schemaVersion: 6,
  };
}

let _idCounter = 0;
export function newId(): string {
  return `shape_${Date.now()}_${_idCounter++}`;
}
