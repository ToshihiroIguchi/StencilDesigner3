import type { Polygon, DrcError, Layer } from '../types';
import { polygonBbox, polygonEdgeDistance, polygonNarrowestPassage } from './geometry';

export interface DrcConfig {
  minApertureUm: number;
  minSpacingUm: number;
}

export const DEFAULT_DRC_CONFIG: DrcConfig = {
  minApertureUm: 30,
  minSpacingUm: 30,
};

type Bbox = ReturnType<typeof polygonBbox>;

/** Clearance between two axis-aligned bboxes (negative = overlap). Used as a fast pre-filter. */
function bboxClearance(a: Bbox, b: Bbox): number {
  const ox = Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX);
  const oy = Math.min(a.maxY, b.maxY) - Math.max(a.minY, b.minY);
  if (ox > 0 && oy > 0) return -Math.min(ox, oy);
  const gapX = ox < 0 ? -ox : 0;
  const gapY = oy < 0 ? -oy : 0;
  return Math.sqrt(gapX * gapX + gapY * gapY);
}

const MAX_ERRORS = 20;

export function runDrc(shapes: Polygon[], layers: Layer[], config: DrcConfig): DrcError[] {
  const apertureNames = new Set(layers.filter((l) => l.isAperture).map((l) => l.name));
  const targets = shapes.filter((s) => apertureNames.has(s.layer));
  const errors: DrcError[] = [];
  const items = targets.map((s) => ({ shape: s, bb: polygonBbox(s) }));

  // Aperture check: narrowest passage width (catches thin arms, not just bbox dimensions)
  for (const { shape } of items) {
    const { width, loc } = polygonNarrowestPassage(shape);
    if (width < config.minApertureUm) {
      errors.push({
        shapeId: shape.id,
        message: `Aperture ${Math.round(width)}µm < ${config.minApertureUm}µm`,
        severity: 'error',
        loc,
      });
    }
  }

  // Spacing check: real edge-to-edge distance with bbox pre-filter
  spacingCheck: for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      if (errors.length >= MAX_ERRORS) break spacingCheck;

      // bbox clearance is a lower bound of actual distance — skip if clearly far enough
      if (bboxClearance(items[i].bb, items[j].bb) > config.minSpacingUm) continue;

      const { dist: gap, loc } = polygonEdgeDistance(items[i].shape, items[j].shape);
      if (gap === 0) {
        errors.push({
          shapeId: items[i].shape.id,
          shapeId2: items[j].shape.id,
          message: 'Shapes overlap',
          severity: 'error',
          loc,
        });
      } else if (gap < config.minSpacingUm) {
        errors.push({
          shapeId: items[i].shape.id,
          shapeId2: items[j].shape.id,
          message: `Spacing ${Math.round(gap)}µm < ${config.minSpacingUm}µm`,
          severity: 'warning',
          loc,
        });
      }
    }
  }

  return errors;
}
