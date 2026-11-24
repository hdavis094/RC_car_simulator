import type { Track, GroundPointM } from '@rcsim/schema';
import * as THREE from 'three';

const WALL_THICKNESS_M = 0.04;

export interface SampledTrackCentreline {
  readonly points: readonly GroundPointM[];
  readonly controlIndex: readonly number[];
  readonly lengthM: number;
}

const dist2D = (a: GroundPointM, b: GroundPointM): number => Math.hypot(b.x - a.x, b.z - a.z);

/** Centripetal Catmull-Rom spline interpolation (Barry-Goldman), matching sim-core. */
function catmullRomPoint(
  p0: GroundPointM,
  p1: GroundPointM,
  p2: GroundPointM,
  p3: GroundPointM,
  t: number,
): GroundPointM {
  const k1 = Math.max(Math.sqrt(dist2D(p0, p1)), 1e-6);
  const k2 = Math.max(Math.sqrt(dist2D(p1, p2)), 1e-6);
  const k3 = Math.max(Math.sqrt(dist2D(p2, p3)), 1e-6);
  const t0 = 0;
  const t1 = t0 + k1;
  const t2 = t1 + k2;
  const t3 = t2 + k3;
  const u = t1 + t * (t2 - t1);
  const lerp = (a: GroundPointM, b: GroundPointM, ta: number, tb: number): GroundPointM => {
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

/** Samples a track's centreline to a closed polyline with step ~`stepM` metres. */
export function sampleTrackCentreline(track: Track, stepM = 0.1): SampledTrackCentreline {
  const control = track.centreline.pointsM;
  const n = control.length;
  const at = (i: number): GroundPointM => control[((i % n) + n) % n] as GroundPointM;
  const points: GroundPointM[] = [];
  const controlIndex: number[] = [];

  for (let i = 0; i < n; i++) {
    controlIndex.push(points.length);
    const a = at(i);
    const b = at(i + 1);
    const segments = Math.max(1, Math.ceil(dist2D(a, b) / stepM));
    for (let s = 0; s < segments; s++) {
      points.push(
        track.centreline.kind === 'catmull-rom'
          ? catmullRomPoint(at(i - 1), a, b, at(i + 2), s / segments)
          : { x: a.x + ((b.x - a.x) * s) / segments, z: a.z + ((b.z - a.z) * s) / segments },
      );
    }
  }

  let lengthM = 0;
  for (let i = 0; i < points.length; i++) {
    lengthM += dist2D(points[i] as GroundPointM, points[(i + 1) % points.length] as GroundPointM);
  }
  return { points, controlIndex, lengthM };
}

export function trackTangentAt(points: readonly GroundPointM[], index: number): GroundPointM {
  const n = points.length;
  const a = points[(index - 1 + n) % n] as GroundPointM;
  const b = points[(index + 1) % n] as GroundPointM;
  const len = dist2D(a, b) || 1;
  return { x: (b.x - a.x) / len, z: (b.z - a.z) / len };
}

/** Unit vector to the left of travel direction (yaw 0 faces -Z, so left is -X). */
export const trackLeftOf = (dir: GroundPointM): GroundPointM => ({ x: dir.z, z: -dir.x });

export function offsetTrackLoop(points: readonly GroundPointM[], offsetM: number): GroundPointM[] {
  return points.map((p, i) => {
    const left = trackLeftOf(trackTangentAt(points, i));
    return { x: p.x + left.x * offsetM, z: p.z + left.z * offsetM };
  });
}

export interface TrackWallSegment {
  readonly edge: 'left' | 'right';
  readonly position: readonly [number, number, number];
  readonly yawRad: number;
  readonly thicknessM: number;
  readonly heightM: number;
  readonly lengthM: number;
}

export interface StartFinishLineData {
  readonly position: readonly [number, number, number];
  readonly yawRad: number;
  readonly widthM: number;
  readonly depthM: number;
  readonly direction: GroundPointM;
}

export interface GeneratedTrackMeshData {
  readonly trackId: string;
  readonly centrePoints: readonly GroundPointM[];
  readonly leftEdgePoints: readonly GroundPointM[];
  readonly rightEdgePoints: readonly GroundPointM[];
  readonly surfacePositions: Float32Array;
  readonly surfaceIndices: Uint32Array;
  readonly walls: readonly TrackWallSegment[];
  readonly startFinish: StartFinishLineData;
  readonly bounds: {
    readonly minX: number;
    readonly maxX: number;
    readonly minZ: number;
    readonly maxZ: number;
    readonly centerX: number;
    readonly centerZ: number;
    readonly spanM: number;
  };
}

const trackMeshCache = new Map<string, GeneratedTrackMeshData>();

function computeTrackMeshData(track: Track, stepM = 0.12): GeneratedTrackMeshData {
  const sampled = sampleTrackCentreline(track, stepM);
  const halfWidth = track.widthM / 2;
  const leftEdge = offsetTrackLoop(sampled.points, halfWidth);
  const rightEdge = offsetTrackLoop(sampled.points, -halfWidth);
  const n = sampled.points.length;

  const surfaceY = 0.003;
  const surfacePositions = new Float32Array(n * 2 * 3);
  const surfaceIndices = new Uint32Array(n * 6);

  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;

  for (let i = 0; i < n; i++) {
    const l = leftEdge[i] as GroundPointM;
    const r = rightEdge[i] as GroundPointM;

    minX = Math.min(minX, l.x, r.x);
    maxX = Math.max(maxX, l.x, r.x);
    minZ = Math.min(minZ, l.z, r.z);
    maxZ = Math.max(maxZ, l.z, r.z);

    const baseV = i * 6;
    surfacePositions[baseV] = l.x;
    surfacePositions[baseV + 1] = surfaceY;
    surfacePositions[baseV + 2] = l.z;
    surfacePositions[baseV + 3] = r.x;
    surfacePositions[baseV + 4] = surfaceY;
    surfacePositions[baseV + 5] = r.z;

    const next = (i + 1) % n;
    const li = i * 2;
    const ri = i * 2 + 1;
    const lNext = next * 2;
    const rNext = next * 2 + 1;

    const baseI = i * 6;
    surfaceIndices[baseI] = li;
    surfaceIndices[baseI + 1] = ri;
    surfaceIndices[baseI + 2] = lNext;
    surfaceIndices[baseI + 3] = ri;
    surfaceIndices[baseI + 4] = rNext;
    surfaceIndices[baseI + 5] = lNext;
  }

  const walls: TrackWallSegment[] = [];
  if (track.wallHeightM > 0) {
    const wallOffset = halfWidth + WALL_THICKNESS_M / 2;
    for (const [offset, edge] of [
      [wallOffset, 'left'],
      [-wallOffset, 'right'],
    ] as const) {
      const wallLoop = offsetTrackLoop(sampled.points, offset);
      // Coalesce adjacent samples by stride 2 for clean visual wall segments
      const stride = 2;
      for (let i = 0; i < wallLoop.length; i += stride) {
        const a = wallLoop[i] as GroundPointM;
        const b = wallLoop[(i + stride) % wallLoop.length] as GroundPointM;
        const segLen = dist2D(a, b);
        if (segLen < 1e-4) continue;
        const yawRad = Math.atan2(b.x - a.x, b.z - a.z);
        walls.push({
          edge,
          position: [(a.x + b.x) / 2, track.wallHeightM / 2, (a.z + b.z) / 2],
          yawRad,
          thicknessM: WALL_THICKNESS_M,
          heightM: track.wallHeightM,
          lengthM: segLen + WALL_THICKNESS_M * 0.6,
        });
      }
    }
  }

  const sfSampleIdx = sampled.controlIndex[track.startFinish.point] ?? 0;
  const sfPoint = (sampled.points[sfSampleIdx] ?? { x: 0, z: 0 }) as GroundPointM;
  const sfDir = trackTangentAt(sampled.points, sfSampleIdx);
  // At yaw 0, car forward is -Z (sfDir = { x: 0, z: -1 }).
  const sfYawRad = Math.atan2(-sfDir.x, -sfDir.z);

  const startFinish: StartFinishLineData = {
    position: [sfPoint.x, 0.006, sfPoint.z],
    yawRad: sfYawRad,
    widthM: track.widthM,
    depthM: 0.24,
    direction: sfDir,
  };

  if (!Number.isFinite(minX)) {
    minX = -5;
    maxX = 5;
    minZ = -5;
    maxZ = 5;
  }

  const centerX = (minX + maxX) / 2;
  const centerZ = (minZ + maxZ) / 2;
  const spanM = Math.max(maxX - minX, maxZ - minZ, 4);

  return {
    trackId: track.id,
    centrePoints: sampled.points,
    leftEdgePoints: leftEdge,
    rightEdgePoints: rightEdge,
    surfacePositions,
    surfaceIndices,
    walls,
    startFinish,
    bounds: {
      minX,
      maxX,
      minZ,
      maxZ,
      centerX,
      centerZ,
      spanM,
    },
  };
}

/**
 * Generates (and memoizes per `track.id` and `stepM`) the 3D track surface ribbon,
 * left/right walls, and start/finish line from Track data.
 */
export function generateTrackMeshData(track: Track, stepM = 0.12): GeneratedTrackMeshData {
  const key = `${track.id}:${stepM}:${track.widthM}:${track.wallHeightM}:${track.centreline.pointsM.length}`;
  const cached = trackMeshCache.get(key);
  if (cached) return cached;
  const generated = computeTrackMeshData(track, stepM);
  trackMeshCache.set(key, generated);
  return generated;
}

/** Builds a Three.js BufferGeometry for the track surface ribbon. */
export function buildTrackSurfaceGeometry(meshData: GeneratedTrackMeshData): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(meshData.surfacePositions, 3));
  geometry.setIndex(new THREE.BufferAttribute(meshData.surfaceIndices, 1));
  geometry.computeVertexNormals();
  return geometry;
}
