import type { Track } from '@rcsim/schema';
import { describe, expect, it } from 'vitest';
import {
  offsetLoop,
  sampleCentreline,
  simplifyLoop,
  tangentAt,
  type Point2,
} from './track-geometry.ts';
import { trackLibrary } from './track-library.ts';

/** Smallest radius of curvature along a closed loop, from three-point circles. */
function minRadius(points: readonly Point2[], stride = 5): number {
  let min = Infinity;
  const n = points.length;
  for (let i = 0; i < n; i++) {
    const a = points[i]!;
    const b = points[(i + stride) % n]!;
    const c = points[(i + 2 * stride) % n]!;
    const ab = Math.hypot(b.x - a.x, b.z - a.z);
    const bc = Math.hypot(c.x - b.x, c.z - b.z);
    const ca = Math.hypot(a.x - c.x, a.z - c.z);
    const area2 = Math.abs((b.x - a.x) * (c.z - a.z) - (c.x - a.x) * (b.z - a.z));
    if (area2 > 1e-9) min = Math.min(min, (ab * bc * ca) / (2 * area2));
  }
  return min;
}

describe('track library', () => {
  it('lists the built-in tracks and loads them by id', () => {
    expect(trackLibrary.ids()).toEqual(expect.arrayContaining(['oval', 'technical']));
    for (const id of trackLibrary.ids()) expect(trackLibrary.load(id).id).toBe(id);
  });

  it('throws on an unknown id, naming the choices', () => {
    expect(() => trackLibrary.load('nurburgring')).toThrow(/oval/);
  });
});

describe('oval', () => {
  const track = trackLibrary.load('oval');
  const { points, lengthM } = sampleCentreline(track);

  it('is about 12 × 6 m outside, with a 1.2 m lane', () => {
    expect(track.widthM).toBeCloseTo(1.2);
    const outer = [
      ...offsetLoop(points, track.widthM / 2),
      ...offsetLoop(points, -track.widthM / 2),
    ];
    const xs = outer.map((p) => p.x);
    const zs = outer.map((p) => p.z);
    expect(Math.max(...zs) - Math.min(...zs)).toBeGreaterThan(11.5);
    expect(Math.max(...zs) - Math.min(...zs)).toBeLessThan(12.5);
    expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(5.5);
    expect(Math.max(...xs) - Math.min(...xs)).toBeLessThan(6.5);
    // the stadium's centreline: two 6 m straights and two 2.4 m radius ends
    expect(lengthM).toBeGreaterThan(26.5);
    expect(lengthM).toBeLessThan(27.7);
  });

  it('can be driven: the tightest bend is wider than the car can turn', () => {
    expect(minRadius(points)).toBeGreaterThan(0.9);
  });

  it('starts just behind the start/finish line, heading along the track', () => {
    const line =
      sampleCentreline(track).points[
        sampleCentreline(track).controlIndex[track.startFinish.point]!
      ]!;
    const toStart = Math.hypot(track.start.positionM.x - line.x, track.start.positionM.z - line.z);
    expect(toStart).toBeGreaterThan(0.3);
    expect(toStart).toBeLessThan(1.5);
  });
});

describe('technical', () => {
  const track = trackLibrary.load('technical');
  const { points, lengthM } = sampleCentreline(track);

  it('is about a 20 m lap', () => {
    expect(lengthM).toBeGreaterThan(18.5);
    expect(lengthM).toBeLessThan(21.5);
  });

  it('has bends the car can take: the hairpin and chicane are wider than its turning circle', () => {
    expect(minRadius(points)).toBeGreaterThan(0.9);
  });

  it('keeps separate parts of the lane apart, so the walls never touch', () => {
    const n = points.length;
    const clearance = track.widthM + 0.3;
    for (let i = 0; i < n; i += 3) {
      for (let j = i + 1; j < n; j += 3) {
        // distance along the loop, either way round
        const gap = Math.min(j - i, n - (j - i)) * 0.1;
        if (gap < 3) continue;
        const d = Math.hypot(points[i]!.x - points[j]!.x, points[i]!.z - points[j]!.z);
        expect(d).toBeGreaterThan(clearance);
      }
    }
  });
});

describe('geometry helpers', () => {
  const square: Track['centreline'] = {
    kind: 'polyline',
    pointsM: [
      { x: 0, z: 0 },
      { x: 0, z: -4 },
      { x: -4, z: -4 },
      { x: -4, z: 0 },
    ],
  };
  const track = { ...trackLibrary.load('oval'), centreline: square } as Track;

  it('samples a polyline at its corners, with the control points among the samples', () => {
    const sampled = sampleCentreline(track, 0.5);
    expect(sampled.lengthM).toBeCloseTo(16);
    for (const [i, p] of square.pointsM.entries()) {
      expect(sampled.points[sampled.controlIndex[i]!]).toEqual(p);
    }
  });

  it('offsets to the left of travel (−X when heading −Z)', () => {
    const { points } = sampleCentreline(track, 0.5);
    const mid = points.findIndex((p) => p.x === 0 && p.z === -2);
    const left = offsetLoop(points, 0.3)[mid]!;
    expect(left.x).toBeCloseTo(-0.3);
    expect(left.z).toBeCloseTo(-2);
    expect(tangentAt(points, mid)).toEqual({ x: 0, z: -1 });
  });

  it('simplifies collinear runs and keeps the corners', () => {
    const { points } = sampleCentreline(track, 0.25);
    const simple = simplifyLoop(points, 0.001);
    expect(simple.length).toBe(4);
  });
});
