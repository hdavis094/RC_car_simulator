import type { Quat, Vec3 } from '../api/math.ts';

/** Hamilton product a × b (apply b, then a). */
export function quatMul(a: Quat, b: Quat): Quat {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
}

/** Rotation by `rad` about +Y (positive turns left). */
export function quatY(rad: number): Quat {
  return [0, Math.sin(rad / 2), 0, Math.cos(rad / 2)];
}

/** Rotation by `rad` about +X. */
export function quatX(rad: number): Quat {
  return [Math.sin(rad / 2), 0, 0, Math.cos(rad / 2)];
}

/** Rotates a vector by a unit quaternion. */
export function rotate(q: Quat, v: Vec3): Vec3 {
  const [qx, qy, qz, qw] = q;
  // t = 2 q.xyz × v ; v' = v + w t + q.xyz × t
  const tx = 2 * (qy * v[2] - qz * v[1]);
  const ty = 2 * (qz * v[0] - qx * v[2]);
  const tz = 2 * (qx * v[1] - qy * v[0]);
  return [
    v[0] + qw * tx + (qy * tz - qz * ty),
    v[1] + qw * ty + (qz * tx - qx * tz),
    v[2] + qw * tz + (qx * ty - qy * tx),
  ];
}

/** Yaw (about +Y, positive left) of a rotation's forward (−Z) axis, radians. */
export function yawOf(q: Quat): number {
  const [fx, , fz] = rotate(q, [0, 0, -1]);
  return Math.atan2(-fx, -fz);
}

export const DEG = Math.PI / 180;
