import type { Track } from '@rcsim/schema';

/** A point on the ground plane, metres (+X right, −Z forward at yaw 0). */
export interface Point2 {
  readonly x: number;
  readonly z: number;
}

/** The centreline sampled to a closed polyline, in driving order. */
export interface SampledCentreline {
  /** Samples, without repeating the first at the end. */
  readonly points: readonly Point2[];
  /** Index in `points` of each control point of the track data. */
  readonly controlIndex: readonly number[];
  /** Length of the closed loop, metres. */
  readonly lengthM: number;
}

const dist = (a: Point2, b: Point2): number => Math.hypot(b.x - a.x, b.z - a.z);

/** Centripetal Catmull-Rom point at t∈[0,1] between p1 and p2 (Barry–Goldman). */
function catmullRom(p0: Point2, p1: Point2, p2: Point2, p3: Point2, t: number): Point2 {
  // Knot spacing d^0.5; guard coincident points.
  const k1 = Math.max(Math.sqrt(dist(p0, p1)), 1e-6);
  const k2 = Math.max(Math.sqrt(dist(p1, p2)), 1e-6);
  const k3 = Math.max(Math.sqrt(dist(p2, p3)), 1e-6);
  const t0 = 0;
  const t1 = t0 + k1;
  const t2 = t1 + k2;
  const t3 = t2 + k3;
  const u = t1 + t * (t2 - t1);
  const lerp = (a: Point2, b: Point2, ta: number, tb: number): Point2 => {
    const w = (u - ta) / (tb - ta);
    return { x: a.x + (b.x - a.x) * w, z: a.z + (b.z - a.z) * w };
  };
  const a1 = lerp(p0, p1, t0, t1);
  const a2 = lerp(p1, p2, t1, t2);
  const a3 = lerp(p2, p3, t2, t3);
  const b1 = lerp(a1, a2, t0, t2);
  const b2 = lerp(a2, a3, t1, t3);
  return lerp(b1, b2, t1, t2);
}

/**
 * Samples the track's centreline to a closed polyline with points about
 * `stepM` apart. Each control point is a sample, so `controlIndex` is exact.
 */
export function sampleCentreline(track: Track, stepM = 0.1): SampledCentreline {
  const control = track.centreline.pointsM;
  const n = control.length;
  const at = (i: number): Point2 => control[((i % n) + n) % n] as Point2;
  const points: Point2[] = [];
  const controlIndex: number[] = [];
  for (let i = 0; i < n; i++) {
    controlIndex.push(points.length);
    const a = at(i);
    const b = at(i + 1);
    const segments = Math.max(1, Math.ceil(dist(a, b) / stepM));
    for (let s = 0; s < segments; s++) {
      points.push(
        track.centreline.kind === 'catmull-rom'
          ? catmullRom(at(i - 1), a, b, at(i + 2), s / segments)
          : { x: a.x + ((b.x - a.x) * s) / segments, z: a.z + ((b.z - a.z) * s) / segments },
      );
    }
  }
  let lengthM = 0;
  for (let i = 0; i < points.length; i++) {
    lengthM += dist(points[i] as Point2, points[(i + 1) % points.length] as Point2);
  }
  return { points, controlIndex, lengthM };
}

/** Unit tangent at sample `i`, in driving order. */
export function tangentAt(points: readonly Point2[], i: number): Point2 {
  const n = points.length;
  const a = points[(i - 1 + n) % n] as Point2;
  const b = points[(i + 1) % n] as Point2;
  const len = dist(a, b) || 1;
  return { x: (b.x - a.x) / len, z: (b.z - a.z) / len };
}

/** Unit vector to the left of a direction of travel (yaw 0 faces −Z, so left is −X). */
export const leftOf = (d: Point2): Point2 => ({ x: d.z, z: -d.x });

/** The centreline shifted `offsetM` to the left (negative: right), sample by sample. */
export function offsetLoop(points: readonly Point2[], offsetM: number): Point2[] {
  return points.map((p, i) => {
    const left = leftOf(tangentAt(points, i));
    return { x: p.x + left.x * offsetM, z: p.z + left.z * offsetM };
  });
}

/**
 * Douglas–Peucker on a closed loop: fewer, longer wall pieces on straights
 * (so no seams for the car to catch on) and chord error ≤ `toleranceM`.
 * Returns the kept points, in order; the loop closes from last to first.
 */
export function simplifyLoop(points: readonly Point2[], toleranceM: number): Point2[] {
  const n = points.length;
  if (n < 4) return [...points];
  // Anchor on the sample farthest from the first, then simplify both halves.
  let far = 0;
  let best = -1;
  for (let i = 1; i < n; i++) {
    const d = dist(points[0] as Point2, points[i] as Point2);
    if (d > best) {
      best = d;
      far = i;
    }
  }
  const keep = new Array<boolean>(n).fill(false);
  keep[0] = true;
  keep[far] = true;
  const recurse = (lo: number, hi: number): void => {
    if (hi - lo < 2) return;
    const a = points[lo % n] as Point2;
    const b = points[hi % n] as Point2;
    const len = dist(a, b) || 1;
    let worst = -1;
    let worstAt = -1;
    for (let i = lo + 1; i < hi; i++) {
      const p = points[i % n] as Point2;
      const d = Math.abs((b.x - a.x) * (a.z - p.z) - (a.x - p.x) * (b.z - a.z)) / len;
      if (d > worst) {
        worst = d;
        worstAt = i;
      }
    }
    if (worst > toleranceM) {
      keep[worstAt % n] = true;
      recurse(lo, worstAt);
      recurse(worstAt, hi);
    }
  };
  recurse(0, far);
  recurse(far, n);
  return points.filter((_, i) => keep[i]);
}

/** The start/finish line: a point on the centreline and the direction of travel through it. */
export interface FinishLine {
  readonly point: Point2;
  /** Unit direction of travel. */
  readonly direction: Point2;
}

export function finishLineOf(track: Track, sampled: SampledCentreline): FinishLine {
  const index = sampled.controlIndex[track.startFinish.point] ?? 0;
  return {
    point: sampled.points[index] as Point2,
    direction: tangentAt(sampled.points, index),
  };
}
