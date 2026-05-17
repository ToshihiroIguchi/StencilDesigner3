import type { DimensionAnchor } from '../types';
import type { SnapResult } from './snap';

/** Convert a SnapResult into a DimensionAnchor for use in Dimension/Arrow/Centerline tools. */
export function snapToDimensionAnchor(snap: SnapResult): DimensionAnchor {
  const ref = snap.ref;
  if (ref?.kind === 'vertex') {
    return {
      kind: 'vertex',
      shapeId: ref.shapeId,
      ringIndex: ref.ringIndex,
      vertexId: ref.vertexId,
      cachedPoint: snap.point,
    };
  }
  if (ref?.kind === 'edge') {
    return {
      kind: 'edge',
      shapeId: ref.shapeId,
      ringIndex: ref.ringIndex,
      edgeStartId: ref.edgeStartId,
      edgeEndId: ref.edgeEndId,
      t: ref.t,
      cachedPoint: snap.point,
    };
  }
  // midpoint, center, grid → free anchor (absolute coordinate)
  return { kind: 'free', point: snap.point };
}
