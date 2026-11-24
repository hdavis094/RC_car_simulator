/** Stage-2 tyre values for a 1/10 car on a smooth floor (estimates, not measured). */
export const TYRE = {
  /** Peak tyre force as a multiple of the wheel's load (μ). */
  friction: 0.9,
  /** Lateral force per radian of slip angle, as a multiple of the load, 1/rad. */
  corneringStiffness: 8,
  /** The slip angle is measured against at least this rolling speed, m/s. */
  slipSpeedFloorMps: 0.3,
} as const;

/** One wheel on the ground, in its own heading, for one step. */
export interface TyreContact {
  /** Normal load, N. */
  readonly loadN: number;
  /** Contact point velocity along the wheel's heading and to its right, m/s. */
  readonly forwardMps: number;
  readonly rightMps: number;
  /** Force the drivetrain asks for along the heading, N. */
  readonly driveN: number;
  /** Rolling resistance plus brake, N (a magnitude): opposes rolling. */
  readonly resistN: number;
  /** Mass this wheel has to move to change its velocity in each direction, kg. */
  readonly forwardMassKg: number;
  readonly rightMassKg: number;
  readonly dtS: number;
}

/** Impulse on the car at the contact point, N·s, along the heading and to the right. */
export interface TyreImpulse {
  readonly forward: number;
  readonly right: number;
}

/**
 * The tyre's impulse over one step:
 *
 * - sideways, a force proportional to the slip angle, saturating at μ × load;
 * - along the heading, the drive force less the resistance;
 * - together never more than μ × load × dt (the friction circle): beyond
 *   that the tyre slides, spins or locks.
 *
 * Neither resistance nor cornering ever reverses the velocity it opposes, so
 * a parked car stays put and long ticks stay stable.
 */
export function tyreImpulse(contact: TyreContact): TyreImpulse {
  const { loadN, forwardMps, rightMps, dtS } = contact;
  if (loadN <= 0) return { forward: 0, right: 0 };

  const slipRad = Math.atan2(rightMps, Math.max(Math.abs(forwardMps), TYRE.slipSpeedFloorMps));
  const lateralN = Math.min(TYRE.corneringStiffness * Math.abs(slipRad), TYRE.friction) * loadN;
  let right =
    -Math.sign(rightMps) * Math.min(lateralN * dtS, Math.abs(rightMps) * contact.rightMassKg);

  const drive = contact.driveN * dtS;
  const rolling = forwardMps + drive / contact.forwardMassKg;
  let forward =
    drive -
    Math.sign(rolling) * Math.min(contact.resistN * dtS, Math.abs(rolling) * contact.forwardMassKg);

  const limit = TYRE.friction * loadN * dtS;
  const total = Math.hypot(forward, right);
  if (total > limit) {
    forward *= limit / total;
    right *= limit / total;
  }
  return { forward, right };
}
