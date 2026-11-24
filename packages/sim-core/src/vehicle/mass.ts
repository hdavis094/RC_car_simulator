import type { Vec3 } from '../api/math.ts';

/** A mass at a point in the chassis frame. */
export interface PointMass {
  readonly massKg: number;
  readonly atM: Vec3;
}

export interface MassProperties {
  /** Centre of gravity in the chassis frame, metres. */
  readonly cogM: Vec3;
  /** Moments of inertia about the centre of gravity, along the chassis axes, kg·m². */
  readonly inertiaKgM2: { readonly x: number; readonly y: number; readonly z: number };
}

/** The car's body box, metres. */
export interface BoxM {
  readonly width: number;
  readonly height: number;
  readonly length: number;
}

/** Moments of inertia of a uniform box about its centre, kg·m². */
export function boxInertia(massKg: number, box: BoxM): MassProperties['inertiaKgM2'] {
  return {
    x: (massKg * (box.height ** 2 + box.length ** 2)) / 12,
    y: (massKg * (box.width ** 2 + box.length ** 2)) / 12,
    z: (massKg * (box.width ** 2 + box.height ** 2)) / 12,
  };
}

/**
 * Physics stage 2: `body` (the chassis and the unplaced parts) is a uniform box
 * centred on the chassis' centre of gravity, and each placed part a point mass.
 * The centre of gravity is their weighted mean; the inertia adds each one's
 * parallel-axis term. Products of inertia are neglected.
 */
export function massProperties(
  body: PointMass,
  placed: readonly PointMass[],
  box: BoxM,
): MassProperties {
  const all = [body, ...placed];
  const total = all.reduce((sum, p) => sum + p.massKg, 0);
  // Offsets from the body's centre: with nothing placed, the centre is exact.
  const mean = (axis: 0 | 1 | 2): number =>
    body.atM[axis] +
    placed.reduce((sum, p) => sum + p.massKg * (p.atM[axis] - body.atM[axis]), 0) / total;
  const cogM: Vec3 = total > 0 ? [mean(0), mean(1), mean(2)] : body.atM;
  const inertia = { ...boxInertia(body.massKg, box) };
  for (const { massKg, atM } of all) {
    const x = atM[0] - cogM[0];
    const y = atM[1] - cogM[1];
    const z = atM[2] - cogM[2];
    inertia.x += massKg * (y * y + z * z);
    inertia.y += massKg * (x * x + z * z);
    inertia.z += massKg * (x * x + y * y);
  }
  return { cogM, inertiaKgM2: inertia };
}
