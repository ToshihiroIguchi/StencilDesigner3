import type { Font, Glyph } from 'opentype.js';
import type { Polygon, Ring } from '../types';
import { newId } from '../types';
import { normalize } from '../normalize';
import { vertex } from './vertex';

const CUBIC_SEGMENTS = 16;
const QUAD_SEGMENTS = 8;

/** Returns true when every character is ASCII printable (U+0020–U+007E, non-empty). */
export function isAsciiPrintable(text: string): boolean {
  return /^[\x20-\x7E]+$/.test(text);
}

/**
 * Convert a text string to Polygon[] using the given opentype.js Font.
 * Each glyph may produce one or more Polygons (e.g. 'i' → dot + body).
 * Placement origin is the baseline start in world µm coordinates.
 *
 * @param capHeightUm  Desired cap-height in µm (height of capital letters like 'I')
 */
export function textToPolygons(
  text: string,
  font: Font,
  capHeightUm: number,
  originX: number,
  originY: number,
  letterSpacingUm: number,
  layer: string,
): Polygon[] {
  // Scale so cap-height matches capHeightUm.
  // sCapHeight is in font units; fall back to 70% of unitsPerEm if missing.
  const capHeightFU: number =
    (font.tables.os2?.sCapHeight ?? 0) > 0
      ? font.tables.os2!.sCapHeight
      : Math.round(font.unitsPerEm * 0.7);
  const scale = capHeightUm / capHeightFU;

  const result: Polygon[] = [];
  let cursorX = originX;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const glyph: Glyph = font.charToGlyph(char);

    const rings = glyphToRings(glyph, scale, cursorX, originY, font.unitsPerEm);
    const polys = groupRingsToPolygons(rings, layer);
    result.push(...polys);

    const nextGlyph: Glyph | null = i + 1 < text.length ? font.charToGlyph(text[i + 1]) : null;
    const kern = nextGlyph ? font.getKerningValue(glyph, nextGlyph) : 0;
    cursorX += Math.round((glyph.advanceWidth + kern) * scale) + letterSpacingUm;
  }

  return result;
}

// ── Glyph → Ring[] ───────────────────────────────────────────────────────────

function glyphToRings(
  glyph: Glyph,
  scale: number,
  originX: number,
  originY: number,
  unitsPerEm: number,
): Ring[] {
  // getPath(x, y, fontSize=unitsPerEm) returns coords in font units with Y already flipped
  // (opentype.js convention: Y+ down, matching screen coords).
  // Using unitsPerEm as fontSize gives 1:1 font-unit coordinates, so our scale applies directly.
  const path = glyph.getPath(0, 0, unitsPerEm);
  const rings: Ring[] = [];
  let cur: Ring = [];
  let px = 0;
  let py = 0;

  // No additional Y-flip needed: opentype already converted to Y+ down.
  const toWorld = (fx: number, fy: number) =>
    vertex(originX + fx * scale, originY + fy * scale);

  for (const cmd of path.commands) {
    switch (cmd.type) {
      case 'M':
        if (cur.length >= 3) rings.push(cur);
        cur = [];
        cur.push(toWorld(cmd.x, cmd.y));
        px = cmd.x; py = cmd.y;
        break;

      case 'L':
        cur.push(toWorld(cmd.x, cmd.y));
        px = cmd.x; py = cmd.y;
        break;

      case 'C': {
        // Cubic Bézier: P0=current, P1=(x1,y1), P2=(x2,y2), P3=(x,y)
        const x1 = cmd.x1 ?? cmd.x, y1 = cmd.y1 ?? cmd.y;
        const x2 = cmd.x2 ?? cmd.x, y2 = cmd.y2 ?? cmd.y;
        for (let s = 1; s <= CUBIC_SEGMENTS; s++) {
          const t = s / CUBIC_SEGMENTS;
          const mt = 1 - t;
          const fx = mt*mt*mt*px + 3*mt*mt*t*x1 + 3*mt*t*t*x2 + t*t*t*cmd.x;
          const fy = mt*mt*mt*py + 3*mt*mt*t*y1 + 3*mt*t*t*y2 + t*t*t*cmd.y;
          cur.push(toWorld(fx, fy));
        }
        px = cmd.x; py = cmd.y;
        break;
      }

      case 'Q': {
        // Quadratic Bézier: P0=current, P1=(x1,y1), P2=(x,y)
        const x1 = cmd.x1 ?? cmd.x, y1 = cmd.y1 ?? cmd.y;
        for (let s = 1; s <= QUAD_SEGMENTS; s++) {
          const t = s / QUAD_SEGMENTS;
          const mt = 1 - t;
          const fx = mt*mt*px + 2*mt*t*x1 + t*t*cmd.x;
          const fy = mt*mt*py + 2*mt*t*y1 + t*t*cmd.y;
          cur.push(toWorld(fx, fy));
        }
        px = cmd.x; py = cmd.y;
        break;
      }

      case 'Z':
        if (cur.length >= 3) rings.push(cur);
        cur = [];
        break;
    }
  }
  if (cur.length >= 3) rings.push(cur);
  return rings;
}

// ── Ring grouping ─────────────────────────────────────────────────────────────

function signedArea(ring: Ring): number {
  let a = 0;
  const n = ring.length;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    a += ring[i].x * ring[j].y;
    a -= ring[j].x * ring[i].y;
  }
  return a / 2;
}

/** Ray-cast point-in-polygon (even–odd rule). */
function pointInRing(px: number, py: number, ring: Ring): boolean {
  let inside = false;
  const n = ring.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = ring[i].x, yi = ring[i].y;
    const xj = ring[j].x, yj = ring[j].y;
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * Group flat Ring[] into Polygon[].
 * Outer rings (by area) contain holes; all are passed through normalize().
 */
function groupRingsToPolygons(rings: Ring[], layer: string): Polygon[] {
  if (rings.length === 0) return [];

  const withArea = rings.map(r => ({ ring: r, absArea: Math.abs(signedArea(r)) }));
  withArea.sort((a, b) => b.absArea - a.absArea); // largest first = outers first

  const assigned = new Set<Ring>();
  const polys: Polygon[] = [];

  for (const { ring: outer } of withArea) {
    if (assigned.has(outer)) continue;
    assigned.add(outer);

    const holes: Ring[] = [];
    const testPt = outer[0];

    for (const { ring: candidate } of withArea) {
      if (assigned.has(candidate)) continue;
      // A ring is a hole of `outer` if its representative point lies inside `outer`.
      if (pointInRing(candidate[0].x, candidate[0].y, outer)) {
        holes.push(candidate);
        assigned.add(candidate);
      }
    }

    // normalize() enforces CCW outer / CW holes, deduplicates, removes collinear points.
    void testPt;
    polys.push(normalize({ id: newId(), outer, holes, layer }));
  }

  return polys;
}
