import type { AppState, Selection, Polygon } from '../types';
import { normalizeAll } from '../normalize';
import { translatePolygon } from './geometry';

/** Find a polygon by ID in state. */
export function findShape(state: AppState, id: string): Polygon | undefined {
  return state.shapes.find((s) => s.id === id);
}

/** Move selected shapes by (dx, dy) µm. Returns new shapes array. */
export function moveShapes(shapes: Polygon[], selection: Selection[], dx: number, dy: number): Polygon[] {
  const ids = new Set(selection.map((s) => s.shapeId));
  const moved = shapes.map((shape) => {
    if (!ids.has(shape.id)) return shape;
    return { ...translatePolygon(shape, dx, dy), id: shape.id };
  });
  return normalizeAll(moved);
}

/** Copy selected shapes by (dx, dy) µm. Returns new shapes array with copies appended. */
export function copyShapes(shapes: Polygon[], selection: Selection[], dx: number, dy: number): Polygon[] {
  const ids = new Set(selection.map((s) => s.shapeId));
  const copies: Polygon[] = [];
  for (const shape of shapes) {
    if (ids.has(shape.id)) {
      copies.push(translatePolygon(shape, dx, dy));
    }
  }
  return normalizeAll([...shapes, ...copies]);
}

/** Delete selected shapes. Returns new shapes array. */
export function deleteShapes(shapes: Polygon[], selection: Selection[]): Polygon[] {
  const ids = new Set(selection.map((s) => s.shapeId));
  return shapes.filter((s) => !ids.has(s.id));
}

/**
 * Array copy: replicate selection in an nx × ny grid.
 * Position (0,0) is the original; skipped.
 * pitchX, pitchY are in µm.
 */
export function arrayCopyShapes(
  shapes: Polygon[],
  selection: Selection[],
  nx: number,
  ny: number,
  pitchX: number,
  pitchY: number
): Polygon[] {
  const ids = new Set(selection.map((s) => s.shapeId));
  const originals = shapes.filter((s) => ids.has(s.id));
  const copies: Polygon[] = [];

  for (let ix = 0; ix < nx; ix++) {
    for (let iy = 0; iy < ny; iy++) {
      if (ix === 0 && iy === 0) continue; // original position
      const dx = ix * pitchX;
      const dy = iy * pitchY;
      for (const orig of originals) {
        copies.push(translatePolygon(orig, dx, dy));
      }
    }
  }

  return normalizeAll([...shapes, ...copies]);
}

/** Add a new polygon to the state shapes. */
export function addShape(shapes: Polygon[], poly: Polygon): Polygon[] {
  return normalizeAll([...shapes, poly]);
}

/** Get selected polygon IDs from the selection array. */
export function selectedIds(selection: Selection[]): Set<string> {
  return new Set(selection.map((s) => s.shapeId));
}
