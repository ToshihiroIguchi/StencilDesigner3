import type { Ring } from '../types';
import { vertex } from './vertex';

export type FilletSkipReason =
  | 'zero-length-edge'
  | 'near-straight'
  | 'r-too-small'
  | 'r-too-large'
  | 'degenerate';

export type FilletResult =
  | { skipped: false; ring: Ring }
  | { skipped: true; reason: FilletSkipReason };

/**
 * Compute replacement points [T1, ...arcPts, T2] for a single vertex fillet.
 * Returns null with reason when the fillet cannot be applied.
 */
function filletSegment(
  ring: Ring, idx: number, R: number
): { ok: true; pts: Ring } | { ok: false; reason: FilletSkipReason } {
  const n = ring.length;
  const P = ring[(idx - 1 + n) % n];
  const V = ring[idx];
  const N = ring[(idx + 1) % n];

  const dpx = P.x - V.x, dpy = P.y - V.y;
  const dnx = N.x - V.x, dny = N.y - V.y;
  const dpLen = Math.sqrt(dpx * dpx + dpy * dpy);
  const dnLen = Math.sqrt(dnx * dnx + dny * dny);

  if (dpLen < 0.5 || dnLen < 0.5) return { ok: false, reason: 'zero-length-edge' };

  const dpUx = dpx / dpLen, dpUy = dpy / dpLen;
  const dnUx = dnx / dnLen, dnUy = dny / dnLen;
  const dot = Math.max(-1, Math.min(1, dpUx * dnUx + dpUy * dnUy));

  if (dot <= -0.9999) return { ok: false, reason: 'near-straight' };

  const beta = Math.acos(dot);
  const halfBeta = beta / 2;
  const d1Float = R / Math.tan(halfBeta);
  const d1 = Math.round(d1Float);

  if (d1 === 0) return { ok: false, reason: 'r-too-small' };
  if (d1 >= dpLen || d1 >= dnLen) return { ok: false, reason: 'r-too-large' };

  // Tangent points (new geometric vertices, get new IDs)
  const T1 = vertex(V.x + d1Float * dpUx, V.y + d1Float * dpUy);
  const T2 = vertex(V.x + d1Float * dnUx, V.y + d1Float * dnUy);

  const bisRawX = dpUx + dnUx;
  const bisRawY = dpUy + dnUy;
  const bisLen = Math.sqrt(bisRawX * bisRawX + bisRawY * bisRawY);
  if (bisLen < 1e-9) return { ok: false, reason: 'degenerate' };

  const Cfx = V.x + (R / Math.sin(halfBeta)) * (bisRawX / bisLen);
  const Cfy = V.y + (R / Math.sin(halfBeta)) * (bisRawY / bisLen);

  const a1 = Math.atan2(T1.y - Cfy, T1.x - Cfx);
  const a2 = Math.atan2(T2.y - Cfy, T2.x - Cfx);
  let delta = a2 - a1;
  if (delta > Math.PI) delta -= 2 * Math.PI;
  if (delta < -Math.PI) delta += 2 * Math.PI;

  const nSeg = Math.max(2, Math.ceil(Math.abs(delta) / (Math.PI / 30)));
  const arcPts: Ring = [];
  for (let k = 1; k < nSeg; k++) {
    const angle = a1 + delta * (k / nSeg);
    arcPts.push(vertex(Cfx + R * Math.cos(angle), Cfy + R * Math.sin(angle)));
  }

  return { ok: true, pts: [T1, ...arcPts, T2] };
}

/**
 * Apply a fillet of radius R (µm) to vertex at ring[idx].
 * Replaces that vertex with [T1, arc-points..., T2].
 */
export function applyFillet(ring: Ring, idx: number, R: number): FilletResult {
  if (ring.length < 3) return { skipped: true, reason: 'degenerate' };
  const seg = filletSegment(ring, idx, R);
  if (!seg.ok) return { skipped: true, reason: seg.reason };
  return {
    skipped: false,
    ring: [...ring.slice(0, idx), ...seg.pts, ...ring.slice(idx + 1)],
  };
}

/**
 * Apply fillet R to every vertex of ring simultaneously.
 * Vertices where the fillet cannot be applied are kept as-is.
 */
export function roundAllCorners(
  ring: Ring, R: number
): { ring: Ring; applied: number; skipped: number } {
  if (ring.length < 3) return { ring, applied: 0, skipped: 0 };
  const parts: Ring[] = [];
  let applied = 0, skipped = 0;
  for (let i = 0; i < ring.length; i++) {
    const seg = filletSegment(ring, i, R);
    if (!seg.ok) { parts.push([ring[i]]); skipped++; }
    else          { parts.push(seg.pts);  applied++; }
  }
  return { ring: ([] as Ring).concat(...parts), applied, skipped };
}

/** Human-readable skip reason. */
export function filletSkipMessage(reason: FilletSkipReason): string {
  switch (reason) {
    case 'zero-length-edge': return 'Edge length is zero';
    case 'near-straight':    return 'Vertex is nearly collinear';
    case 'r-too-small':      return 'R is too small (< 1µm)';
    case 'r-too-large':      return 'R exceeds edge length';
    case 'degenerate':       return 'Shape is degenerate';
  }
}
