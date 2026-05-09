// All coordinates are integers in micrometers (µm). No floating-point geometry.

export interface Point {
  x: number; // integer µm
  y: number; // integer µm
}

/** Closed polygon ring. The last point must NOT equal the first (implicit closure). */
export type Ring = Point[];

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
  | 'dimension';

export interface Selection {
  type: 'vertex' | 'edge' | 'polygon';
  shapeId: string;
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

export interface Dimension {
  id: string;
  kind: 'linear-h' | 'linear-v';
  p1: Point;
  p2: Point;
  /** World coordinate of the dimension line.
   *  linear-h: Y coordinate of the horizontal dim line.
   *  linear-v: X coordinate of the vertical dim line. */
  offset: number;
  layer: string;
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
  return [
    { name: '0',          color: '#4a9eff', linetype: 'CONTINUOUS', lineweight: -1, visible: true, locked: false, plot: true,  isAperture: true  },
    { name: 'REGMARK',    color: '#ff4444', linetype: 'CONTINUOUS', lineweight: -1, visible: true, locked: false, plot: true,  isAperture: true  },
    { name: 'OUTLINE',    color: '#888888', linetype: 'DASHED',     lineweight: -1, visible: true, locked: false, plot: true,  isAperture: false },
    { name: 'DIMENSIONS', color: '#888888', linetype: 'CONTINUOUS', lineweight: -1, visible: true, locked: false, plot: false, isAperture: false },
  ];
}

export function createDefaultState(): AppState {
  return {
    shapes: [],
    activeTool: 'select',
    selection: [],
    zoom: 0.5, // 0.5 canvas pixels per µm (1mm = 500px)
    panX: 50,
    panY: 50,
    snapEnabled: true,
    gridSize: 1000, // 1mm grid
    snapRadius: 8, // pixels
    layers: defaultLayers(),
    activeLayerName: '0',
    dimensions: [],
    schemaVersion: 3,
  };
}

let _idCounter = 0;
export function newId(): string {
  return `shape_${Date.now()}_${_idCounter++}`;
}
