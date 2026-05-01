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
  | 'line'
  | 'rect'
  | 'circle'
  | 'text'
  | 'move'
  | 'copy'
  | 'delete'
  | 'array'
  | 'union'
  | 'difference';

export interface Selection {
  type: 'vertex' | 'edge' | 'polygon';
  shapeId: string;
  /** vertex/edge index within the outer ring (or hole ring if holeIndex >= 0) */
  index: number;
  holeIndex: number; // -1 = outer ring
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
}

export interface Command {
  do(state: AppState): AppState;
  undo(state: AppState): AppState;
}

export interface DrcError {
  shapeId: string;
  message: string;
  severity: 'error' | 'warning';
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
  };
}

let _idCounter = 0;
export function newId(): string {
  return `shape_${Date.now()}_${_idCounter++}`;
}
