// Polygon splitting by a finite line segment — planar subdivision / face-tracing approach.
// Produces zero-gap cuts, handles concave shapes, multiple chords, and holes.

import type { Point, Polygon, Ring } from '../types';
import { newId } from '../types';
import { normalize } from '../normalize';
import { pointInRing } from '../normalize';
import { segmentIntersectionPoint } from './geometry';
import { vertex } from './vertex';

export type CutResult =
  | { status: 'cut'; pieces: Polygon[] }
  | { status: 'no-cross' }
  | { status: 'degenerate' }; // collinear overlap detected

// ─── Internal types ──────────────────────────────────────────────────────────

interface Node {
  id: number;
  x: number;
  y: number;
}

interface HalfEdge {
  id: number;
  from: number; // node id
  to: number;   // node id
  twin: number; // twin half-edge id
  next: number; // next half-edge in face (-1 until linked)
  isCut: boolean;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function nodeKey(x: number, y: number): string {
  return `${x},${y}`;
}

/** Signed area ×2 of a ring given as node list. Positive = CCW. */
function signedArea2Nodes(nodes: Node[], ids: number[]): number {
  let a = 0;
  const n = ids.length;
  for (let i = 0; i < n; i++) {
    const A = nodes[ids[i]];
    const B = nodes[ids[(i + 1) % n]];
    a += A.x * B.y - B.x * A.y;
  }
  return a;
}

/** Ray-cast point-in-ring test against a node list. */
function pointInNodeRing(px: number, py: number, nodes: Node[], ids: number[]): boolean {
  let inside = false;
  const n = ids.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const A = nodes[ids[i]], B = nodes[ids[j]];
    if ((A.y > py) !== (B.y > py) && px < ((B.x - A.x) * (py - A.y)) / (B.y - A.y) + A.x) {
      inside = !inside;
    }
  }
  return inside;
}

/** Returns true if point p is inside the polygon material (inside outer, outside all holes). */
function pointInPolygon(p: Point, poly: Polygon): boolean {
  if (!pointInRing(p, poly.outer)) return false;
  for (const h of poly.holes) {
    if (pointInRing(p, h)) return false;
  }
  return true;
}

/** Returns true if any ring edge is collinear with (parallel and overlapping) the cut segment. */
function hasCollinearOverlap(ring: Ring, p1: Point, p2: Point): boolean {
  const dx = p2.x - p1.x, dy = p2.y - p1.y;
  const n = ring.length;
  for (let i = 0; i < n; i++) {
    const a = ring[i], b = ring[(i + 1) % n];
    // Check if a→b is collinear with p1→p2 and they share more than a point
    const c1 = (a.x - p1.x) * dy - (a.y - p1.y) * dx;
    const c2 = (b.x - p1.x) * dy - (b.y - p1.y) * dx;
    if (c1 === 0 && c2 === 0) return true; // both endpoints collinear → overlap
  }
  return false;
}

// ─── Main entry point ─────────────────────────────────────────────────────────

/**
 * Cut a polygon with a finite line segment p1→p2.
 * Only cuts where the segment fully traverses through material (boundary-to-boundary chords).
 * Endpoints inside the material produce no cut at that end (finite-segment rule).
 */
export function cutPolygon(poly: Polygon, p1: Point, p2: Point): CutResult {
  // Zero-length cut: never produces a real chord
  if (p1.x === p2.x && p1.y === p2.y) return { status: 'no-cross' };

  // Collinear-overlap guard
  const allRings: Ring[] = [poly.outer, ...poly.holes];
  for (const ring of allRings) {
    if (hasCollinearOverlap(ring, p1, p2)) return { status: 'degenerate' };
  }

  // Build node table and half-edge graph
  let nodeCounter = 0;
  let heCounter = 0;
  const nodeMap = new Map<string, number>(); // key → node id
  const nodes: Node[] = [];
  const halfEdges: HalfEdge[] = [];

  function getOrAddNode(x: number, y: number): number {
    const k = nodeKey(x, y);
    if (nodeMap.has(k)) return nodeMap.get(k)!;
    const id = nodeCounter++;
    nodeMap.set(k, id);
    nodes.push({ id, x, y });
    return id;
  }

  function addHalfEdgePair(fromId: number, toId: number, isCut: boolean): [number, number] {
    const fwdId = heCounter++;
    const revId = heCounter++;
    halfEdges.push({ id: fwdId, from: fromId, to: toId, twin: revId, next: -1, isCut });
    halfEdges.push({ id: revId, from: toId, to: fromId, twin: fwdId, next: -1, isCut });
    return [fwdId, revId];
  }

  // ── Step 1: collect boundary intersections and add ring edges ────────────
  // For each ring, split its edges at intersection points with the cut segment.
  // Track intersection t-values along the segment.

  interface Crossing {
    t: number;   // parameter along cut segment [0,1]
    nodeId: number;
  }
  const crossings: Crossing[] = [];

  for (const ring of allRings) {
    const n = ring.length;
    // Collect intersections on this ring, with edge index
    interface RingCross { edgeIdx: number; tEdge: number; tSeg: number; pt: Point }
    const ringCrosses: RingCross[] = [];

    for (let i = 0; i < n; i++) {
      const a = ring[i], b = ring[(i + 1) % n];
      const res = segmentIntersectionPoint(
        { x: a.x, y: a.y }, { x: b.x, y: b.y },
        p1, p2,
      );
      if (!res) continue;
      // Skip if intersection is exactly at the cut-segment endpoints (tangent touch)
      // — still include to correctly classify inside/outside intervals
      ringCrosses.push({ edgeIdx: i, tEdge: res.t, tSeg: res.u, pt: res.pt });
    }

    // Add original ring vertices as nodes, split at crossing points
    // Build per-edge: (a → [crossings sorted by t] → b)
    const edgeCrosses = new Map<number, RingCross[]>();
    for (const rc of ringCrosses) {
      if (!edgeCrosses.has(rc.edgeIdx)) edgeCrosses.set(rc.edgeIdx, []);
      edgeCrosses.get(rc.edgeIdx)!.push(rc);
    }
    for (const [, list] of edgeCrosses) {
      list.sort((a, b) => a.tEdge - b.tEdge);
    }

    // Walk the ring and build half-edges
    for (let i = 0; i < n; i++) {
      const a = ring[i], b = ring[(i + 1) % n];
      const aId = getOrAddNode(a.x, a.y);
      const bId = getOrAddNode(b.x, b.y);

      const splits = edgeCrosses.get(i) ?? [];
      let prevId = aId;

      for (const rc of splits) {
        const crossNodeId = getOrAddNode(rc.pt.x, rc.pt.y);
        if (crossNodeId !== prevId) {
          addHalfEdgePair(prevId, crossNodeId, false);
        }
        // Record crossing on the segment
        if (!crossings.find((c) => Math.abs(c.t - rc.tSeg) < 1e-10)) {
          crossings.push({ t: rc.tSeg, nodeId: crossNodeId });
        }
        prevId = crossNodeId;
      }

      if (prevId !== bId) {
        addHalfEdgePair(prevId, bId, false);
      }
    }
  }

  if (crossings.length < 2) return { status: 'no-cross' };

  // ── Step 2: identify chords (material-inside sub-segments of cut) ─────────
  crossings.sort((a, b) => a.t - b.t);

  interface Chord { fromNode: number; toNode: number }
  const chords: Chord[] = [];

  for (let i = 0; i < crossings.length - 1; i++) {
    const cA = crossings[i], cB = crossings[i + 1];
    // Midpoint of sub-segment
    const mx = Math.round(p1.x + (cA.t + cB.t) / 2 * (p2.x - p1.x));
    const my = Math.round(p1.y + (cA.t + cB.t) / 2 * (p2.y - p1.y));
    if (pointInPolygon({ x: mx, y: my }, poly)) {
      chords.push({ fromNode: cA.nodeId, toNode: cB.nodeId });
    }
  }

  // Also check the tails (before first crossing and after last crossing)
  // — if p1 is inside the material, that interval is a partial cut → don't add it
  // (finite-segment rule: already handled by only considering between crossings)

  if (chords.length === 0) return { status: 'no-cross' };

  // ── Step 3: add chord half-edges ─────────────────────────────────────────
  for (const chord of chords) {
    if (chord.fromNode !== chord.toNode) {
      addHalfEdgePair(chord.fromNode, chord.toNode, true);
    }
  }

  // ── Step 4: link half-edges — build next pointers via angular sort ────────
  // Group half-edges leaving each node
  const outgoing = new Map<number, number[]>(); // nodeId → [heId, ...]
  for (const he of halfEdges) {
    if (!outgoing.has(he.from)) outgoing.set(he.from, []);
    outgoing.get(he.from)!.push(he.id);
  }

  // For face tracing: next(he) = twin(prev_outgoing_at_destination).
  // At each node, sort outgoing half-edges by angle.
  // next(he_i) = twin(he_j) where he_j is the next CW half-edge after twin(he_i) at he_i.to.
  for (const [nodeId, heIds] of outgoing) {
    const nd = nodes[nodeId];
    // Sort by angle of direction
    heIds.sort((aId, bId) => {
      const heA = halfEdges[aId], heB = halfEdges[bId];
      const toA = nodes[heA.to], toB = nodes[heB.to];
      const angA = Math.atan2(toA.y - nd.y, toA.x - nd.x);
      const angB = Math.atan2(toB.y - nd.y, toB.x - nd.x);
      return angA - angB;
    });

    // next(he) = twin of the CCW-previous outgoing at this node
    // i.e., for each half-edge arriving at this node (= twin of outgoing),
    // its next = next outgoing in CCW order (= next after twin in the sorted list)
    const count = heIds.length;
    for (let i = 0; i < count; i++) {
      const incoming = halfEdges[heIds[i]].twin; // arrives at this node
      // Correct DCEL rule: next(incoming from angle θ) = outgoing at angle just CW of θ
      // = the outgoing at index (i-1) in the CCW-sorted list.
      const nextOut = heIds[(i - 1 + count) % count];
      halfEdges[incoming].next = nextOut;
    }
  }

  // ── Step 5: trace faces ───────────────────────────────────────────────────
  const visited = new Set<number>();
  const faces: number[][] = []; // each face = ordered list of half-edge ids

  for (const he of halfEdges) {
    if (visited.has(he.id)) continue;
    const face: number[] = [];
    let cur = he.id;
    for (let guard = 0; guard < halfEdges.length + 1; guard++) {
      if (visited.has(cur)) break;
      visited.add(cur);
      face.push(cur);
      const next = halfEdges[cur].next;
      if (next === -1) break;
      cur = next;
    }
    if (face.length >= 3) faces.push(face);
  }

  // ── Step 6: classify faces → outer rings and holes ─────────────────────────
  // Build ring node-id sequences from faces
  interface FaceInfo {
    nodeIds: number[];
    area2: number; // signed area ×2
    centroid: Point;
  }

  const faceInfos: FaceInfo[] = faces.map((heIds) => {
    const nodeIds = heIds.map((hid) => halfEdges[hid].from);
    const area2 = signedArea2Nodes(nodes, nodeIds);
    const cx = Math.round(nodeIds.reduce((s, id) => s + nodes[id].x, 0) / nodeIds.length);
    const cy = Math.round(nodeIds.reduce((s, id) => s + nodes[id].y, 0) / nodeIds.length);
    return { nodeIds, area2, centroid: { x: cx, y: cy } };
  });

  // Material face filter. Orientation alone isn't enough: when the polygon has a hole,
  // the hole's REVERSE half-edges trace a phantom CCW face (the hole boundary walked
  // backwards) whose "interior" is actually the hole. We pick a guaranteed-interior
  // point by taking the midpoint of the face's first long edge and offsetting 1 µm
  // toward the face interior (left of a CCW half-edge from A→B = perpendicular (-dy, dx)).
  // A real material face's interior point lies inside the polygon material; a phantom
  // face's interior point lies inside a hole.
  function faceInteriorPoint(face: number[]): Point | null {
    for (const heId of face) {
      const he = halfEdges[heId];
      const a = nodes[he.from], b = nodes[he.to];
      const dx = b.x - a.x, dy = b.y - a.y;
      const len = Math.sqrt(dx * dx + dy * dy);
      if (len < 2) continue;
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2;
      return { x: Math.round(mx - dy / len), y: Math.round(my + dx / len) };
    }
    return null;
  }
  const materialFaces = faces
    .map((face, i) => ({ face, info: faceInfos[i], interior: faceInteriorPoint(face) }))
    .filter(({ info, interior }) =>
      info.area2 > 0 && interior !== null && pointInPolygon(interior, poly),
    )
    .map(({ info }) => info);

  if (materialFaces.length <= 1) {
    // Cut produced only one piece (or none) — treat as no-cross
    return { status: 'no-cross' };
  }

  // Hole faces: CW faces (area2 < 0) inside the original polygon.
  // Exclude the infinite face — in a planar subdivision built from a single polygon,
  // the unbounded face traces the polygon's outer ring CW; it is uniquely identified
  // as the CW face with the largest |area2|.
  const cwFaces = faceInfos.filter((f) => f.area2 < 0);
  let infiniteFaceIdx = -1;
  let maxAbsArea = -1;
  for (let i = 0; i < cwFaces.length; i++) {
    const a = Math.abs(cwFaces[i].area2);
    if (a > maxAbsArea) { maxAbsArea = a; infiniteFaceIdx = i; }
  }
  // Every remaining CW face is a real hole (either a pre-existing one or one carved
  // by the cut). The unbounded face has been removed above; no centroid test needed.
  const holeFaces = cwFaces.filter((_f, i) => i !== infiniteFaceIdx);

  // ── Step 7: assemble result polygons ──────────────────────────────────────
  const results: Polygon[] = [];

  for (const mf of materialFaces) {
    const outerRing: Ring = mf.nodeIds.map((id) => vertex(nodes[id].x, nodes[id].y));

    // Assign holes whose centroid is inside this outer face
    const assignedHoles: Ring[] = [];
    for (const hf of holeFaces) {
      if (pointInNodeRing(hf.centroid.x, hf.centroid.y, nodes, mf.nodeIds)) {
        assignedHoles.push(hf.nodeIds.map((id) => vertex(nodes[id].x, nodes[id].y)));
      }
    }

    // Also keep original holes not crossed by the cut, assigned by containment
    for (const origHole of poly.holes) {
      const testPt = origHole[0];
      if (!pointInNodeRing(testPt.x, testPt.y, nodes, mf.nodeIds)) continue;
      // Check it's not already represented by a hole face (same approximate centroid)
      const cx = Math.round(origHole.reduce((s, p) => s + p.x, 0) / origHole.length);
      const cy = Math.round(origHole.reduce((s, p) => s + p.y, 0) / origHole.length);
      const alreadyCovered = holeFaces.some(
        (hf) => Math.abs(hf.centroid.x - cx) < 2 && Math.abs(hf.centroid.y - cy) < 2,
      );
      if (!alreadyCovered) {
        assignedHoles.push(origHole.map((p) => vertex(p.x, p.y)));
      }
    }

    try {
      results.push(
        normalize({ id: newId(), outer: outerRing, holes: assignedHoles, layer: poly.layer }),
      );
    } catch {
      // Degenerate face — skip
    }
  }

  if (results.length <= 1) return { status: 'no-cross' };
  return { status: 'cut', pieces: results };
}
