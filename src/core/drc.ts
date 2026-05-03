import type { Polygon, DrcError } from '../types';
import { polygonBbox } from './geometry';

export interface DrcConfig {
  minApertureUm: number;
  minSpacingUm: number;
}

export const DEFAULT_DRC_CONFIG: DrcConfig = {
  minApertureUm: 200,
  minSpacingUm: 150,
};

type Bbox = ReturnType<typeof polygonBbox>;

/** Clearance between two axis-aligned bboxes. Negative value means they overlap. */
function bboxClearance(a: Bbox, b: Bbox): number {
  const ox = Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX);
  const oy = Math.min(a.maxY, b.maxY) - Math.max(a.minY, b.minY);
  if (ox > 0 && oy > 0) return -Math.min(ox, oy); // bboxes intersect
  const gapX = ox < 0 ? -ox : 0;
  const gapY = oy < 0 ? -oy : 0;
  return Math.sqrt(gapX * gapX + gapY * gapY);
}

const MAX_ERRORS = 20;

export function runDrc(shapes: Polygon[], config: DrcConfig): DrcError[] {
  const errors: DrcError[] = [];
  const items = shapes.map((s) => ({ shape: s, bb: polygonBbox(s) }));

  for (const { shape, bb } of items) {
    const w = bb.maxX - bb.minX;
    const h = bb.maxY - bb.minY;
    if (w < config.minApertureUm || h < config.minApertureUm) {
      errors.push({
        shapeId: shape.id,
        message: `Aperture ${w}×${h}µm < ${config.minApertureUm}µm`,
        severity: 'error',
      });
    }
  }

  spacingCheck: for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      if (errors.length >= MAX_ERRORS) break spacingCheck;
      const gap = bboxClearance(items[i].bb, items[j].bb);
      if (gap < 0) {
        errors.push({ shapeId: items[i].shape.id, message: 'Shapes overlap', severity: 'error' });
      } else if (gap < config.minSpacingUm) {
        errors.push({
          shapeId: items[i].shape.id,
          message: `Spacing ${Math.round(gap)}µm < ${config.minSpacingUm}µm`,
          severity: 'warning',
        });
      }
    }
  }

  return errors;
}
