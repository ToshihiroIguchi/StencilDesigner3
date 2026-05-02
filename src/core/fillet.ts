import type { Ring } from '../types';

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
 * Apply a fillet of radius R (µm) to vertex at ring[idx].
 * Replaces that vertex with [T1, arc-points..., T2].
 * Returns a new ring or a skip result with reason.
 */
export function applyFillet(ring: Ring, idx: number, R: number): FilletResult {
  const n = ring.length;
  if (n < 3) return { skipped: true, reason: 'degenerate' };

  const P = ring[(idx - 1 + n) % n];
  const V = ring[idx];
  const N = ring[(idx + 1) % n];

  const dpx = P.x - V.x, dpy = P.y - V.y;
  const dnx = N.x - V.x, dny = N.y - V.y;
  const dpLen = Math.sqrt(dpx * dpx + dpy * dpy);
  const dnLen = Math.sqrt(dnx * dnx + dny * dny);

  if (dpLen < 0.5 || dnLen < 0.5) return { skipped: true, reason: 'zero-length-edge' };

  const dpUx = dpx / dpLen;
  const dpUy = dpy / dpLen;
  const dnUx = dnx / dnLen;
  const dnUy = dny / dnLen;

  const dot = Math.max(-1, Math.min(1, dpUx * dnUx + dpUy * dnUy));

  // β ≈ π: P, V, N nearly collinear → bisector (dp+dn) ≈ 0, degenerate
  if (dot <= -0.9999) return { skipped: true, reason: 'near-straight' };

  const beta = Math.acos(dot);
  const halfBeta = beta / 2;

  // Distance from V to tangent points T1/T2 along each edge
  const d1Float = R / Math.tan(halfBeta);
  const d1 = Math.round(d1Float);

  if (d1 === 0) return { skipped: true, reason: 'r-too-small' };
  if (d1 >= dpLen || d1 >= dnLen) return { skipped: true, reason: 'r-too-large' };

  // Tangent points (integer µm)
  const T1 = {
    x: Math.round(V.x + d1Float * dpUx),
    y: Math.round(V.y + d1Float * dpUy),
  };
  const T2 = {
    x: Math.round(V.x + d1Float * dnUx),
    y: Math.round(V.y + d1Float * dnUy),
  };

  // Arc center C (float): V + (R/sin(β/2)) * unit(dp+dn)
  const bisRawX = dpUx + dnUx;
  const bisRawY = dpUy + dnUy;
  const bisLen = Math.sqrt(bisRawX * bisRawX + bisRawY * bisRawY);
  if (bisLen < 1e-9) return { skipped: true, reason: 'degenerate' };
  const Cfx = V.x + (R / Math.sin(halfBeta)) * (bisRawX / bisLen);
  const Cfy = V.y + (R / Math.sin(halfBeta)) * (bisRawY / bisLen);

  // Angular span of the short arc (|delta| < π)
  const a1 = Math.atan2(T1.y - Cfy, T1.x - Cfx);
  const a2 = Math.atan2(T2.y - Cfy, T2.x - Cfx);
  let delta = a2 - a1;
  if (delta > Math.PI) delta -= 2 * Math.PI;
  if (delta < -Math.PI) delta += 2 * Math.PI;

  // Intermediate arc points at ~6° intervals (T1 and T2 appended separately)
  const nSeg = Math.max(2, Math.ceil(Math.abs(delta) / (Math.PI / 30)));
  const arcPts: { x: number; y: number }[] = [];
  for (let k = 1; k < nSeg; k++) {
    const angle = a1 + delta * (k / nSeg);
    arcPts.push({
      x: Math.round(Cfx + R * Math.cos(angle)),
      y: Math.round(Cfy + R * Math.sin(angle)),
    });
  }

  // Replace ring[idx] with [T1, ...arcPts, T2]
  const newRing: Ring = [
    ...ring.slice(0, idx),
    T1,
    ...arcPts,
    T2,
    ...ring.slice(idx + 1),
  ];

  return { skipped: false, ring: newRing };
}

/** Human-readable skip reason (Japanese). */
export function filletSkipMessage(reason: FilletSkipReason): string {
  switch (reason) {
    case 'zero-length-edge': return '辺長がゼロです';
    case 'near-straight':    return '頂点がほぼ直線上にあります（Rは不要）';
    case 'r-too-small':      return 'Rが小さすぎます（1µm未満）';
    case 'r-too-large':      return 'Rが辺長を超えています。より小さいRを指定してください';
    case 'degenerate':       return '形状が縮退しています';
  }
}
