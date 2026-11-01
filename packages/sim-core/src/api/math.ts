// Plain-data geometry shared by every sim-core interface. SI units, right-handed,
// +Y up, −Z forward (AGENTS.md → Units, Coordinates). Tuples, not classes, so
// snapshots cross IPC and structuredClone unchanged.

/** A point or vector in metres (or m/s, rad/s… as the field name says). */
export type Vec3 = readonly [x: number, y: number, z: number];

/** A unit quaternion (x, y, z, w). */
export type Quat = readonly [x: number, y: number, z: number, w: number];

/** A position and orientation in the world frame. */
export interface Pose {
  readonly position: Vec3;
  readonly rotation: Quat;
}

export const IDENTITY_QUAT: Quat = [0, 0, 0, 1];
