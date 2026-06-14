// 2x3 affine transform matrix and recursive INSERT (block reference) expansion.
//
// The matrix uses the column-vector convention [[a c e],[b d f]], mapping a
// point (x,y) to:
//   x' = a*x + c*y + e
//   y' = b*x + d*y + f
// Coordinates stay in DWG mm space (Y-up); µm rounding and the Y-flip are left
// to the importer's mapping helpers (the matrix stage composes in float).

import type { DwgEntity, DwgInsertEntity, DwgPoint3D, DwgBlockRecordTableEntry } from '@mlightcad/libredwg-web';

export interface Mat {
  a: number; b: number; c: number; d: number; e: number; f: number;
}

export function identity(): Mat {
  return { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
}

/** Composition (m1 ∘ m2): applies m2 first, then m1. To push m1 onto child coords use multiply(parent, child). */
export function multiply(m1: Mat, m2: Mat): Mat {
  return {
    a: m1.a * m2.a + m1.c * m2.b,
    b: m1.b * m2.a + m1.d * m2.b,
    c: m1.a * m2.c + m1.c * m2.d,
    d: m1.b * m2.c + m1.d * m2.d,
    e: m1.a * m2.e + m1.c * m2.f + m1.e,
    f: m1.b * m2.e + m1.d * m2.f + m1.f,
  };
}

/** Applies the matrix to point (x,y) in float (caller rounds to µm). */
export function apply(m: Mat, x: number, y: number): { x: number; y: number } {
  return { x: m.a * x + m.c * y + m.e, y: m.b * x + m.d * y + m.f };
}

/**
 * Builds the transform matrix for an INSERT entity.
 * Order of application: subtract the block origin (basePoint) → scale → rotate →
 * translate to the insertion point. That is M = T(insertionPoint) · R · S · T(-basePoint).
 * rotation is in radians (DWG/libredwg convention; verified empirically, spec §8).
 */
export function insertMatrix(ins: DwgInsertEntity, basePoint: DwgPoint3D): Mat {
  const sx = ins.xScale ?? 1;
  const sy = ins.yScale ?? 1;
  const rot = ins.rotation ?? 0;
  const cos = Math.cos(rot);
  const sin = Math.sin(rot);
  const ip = ins.insertionPoint;

  // 2x3 matrix with T(ip) · R · S expanded directly.
  // R·S = [[cos*sx, -sin*sy],[sin*sx, cos*sy]]
  const rs: Mat = {
    a: cos * sx, b: sin * sx,
    c: -sin * sy, d: cos * sy,
    e: ip.x, f: ip.y,
  };
  // Compose T(-basePoint) on the right so the base-point subtraction happens first.
  const tNegBase: Mat = { a: 1, b: 0, c: 0, d: 1, e: -basePoint.x, f: -basePoint.y };
  return multiply(rs, tNegBase);
}

/** Builds a block-name → block-definition index. */
export function buildBlockMap(
  entries: DwgBlockRecordTableEntry[],
): Map<string, DwgBlockRecordTableEntry> {
  const map = new Map<string, DwgBlockRecordTableEntry>();
  for (const e of entries) {
    if (e?.name) map.set(e.name, e);
  }
  return map;
}

/** An entity paired with the accumulated transform to apply to its coordinates. */
export interface PlacedEntity {
  entity: DwgEntity;
  matrix: Mat;
}

const MAX_DEPTH = 16;

/**
 * Walks an entity list, recursively expanding INSERTs into a flat list of
 * "placed" real entities. Non-INSERT entities are emitted as (entity, current matrix).
 * MINSERT (columnCount/rowCount > 1) is replicated by translation across rows×cols.
 * Cycles are guarded by `visited` (block-name set); runaway recursion by a depth limit.
 */
export function flattenEntities(
  entities: DwgEntity[],
  blockMap: Map<string, DwgBlockRecordTableEntry>,
): PlacedEntity[] {
  const out: PlacedEntity[] = [];

  function recurse(ents: DwgEntity[], matrix: Mat, visited: Set<string>, depth: number): void {
    if (depth > MAX_DEPTH) return;
    for (const ent of ents) {
      if (ent.isInPaperSpace) continue;
      if (ent.type === 'INSERT') {
        const ins = ent as DwgInsertEntity;
        const block = blockMap.get(ins.name);
        if (!block) continue;
        if (visited.has(ins.name)) continue; // cycle guard
        const cols = Math.max(1, ins.columnCount ?? 1);
        const rows = Math.max(1, ins.rowCount ?? 1);
        const colSp = ins.columnSpacing ?? 0;
        const rowSp = ins.rowSpacing ?? 0;
        const baseM = insertMatrix(ins, block.basePoint);
        const nextVisited = new Set(visited);
        nextVisited.add(ins.name);
        for (let r = 0; r < rows; r++) {
          for (let c = 0; c < cols; c++) {
            // MINSERT offsets form a grid in the insertion coordinate frame (pre-rotation),
            // added as a translation on the insertion side.
            const offset: Mat = { a: 1, b: 0, c: 0, d: 1, e: c * colSp, f: r * rowSp };
            const cellM = multiply(offset, baseM);
            recurse(block.entities ?? [], multiply(matrix, cellM), nextVisited, depth + 1);
          }
        }
      } else {
        out.push({ entity: ent, matrix });
      }
    }
  }

  recurse(entities, identity(), new Set<string>(), 0);
  return out;
}
