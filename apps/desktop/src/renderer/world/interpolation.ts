import type {
  ObstacleState,
  Pose,
  Quat,
  SensorBeam,
  StateSnapshot,
  Vec3,
  WheelState,
} from '@rcsim/sim-core/api';

const clamp01 = (t: number): number => Math.min(1, Math.max(0, t));

export function lerpNumber(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function lerpVec3(a: Vec3, b: Vec3, t: number): Vec3 {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

export function normalizeVec3(v: Vec3): Vec3 {
  const len = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / len, v[1] / len, v[2] / len];
}

/** Spherical linear interpolation between two unit quaternions (shortest path). */
export function slerpQuat(a: Quat, b: Quat, t: number): Quat {
  if (t <= 0) return a;
  if (t >= 1) return b;

  let [bx, by, bz, bw] = b;
  let dot = a[0] * bx + a[1] * by + a[2] * bz + a[3] * bw;

  // Flip sign if dot < 0 to take the shortest arc on S^3
  if (dot < 0) {
    dot = -dot;
    bx = -bx;
    by = -by;
    bz = -bz;
    bw = -bw;
  }

  if (dot > 0.9995) {
    // Nearly collinear: normalized linear interpolation
    const x = a[0] + (bx - a[0]) * t;
    const y = a[1] + (by - a[1]) * t;
    const z = a[2] + (bz - a[2]) * t;
    const w = a[3] + (bw - a[3]) * t;
    const len = Math.hypot(x, y, z, w) || 1;
    return [x / len, y / len, z / len, w / len];
  }

  const theta0 = Math.acos(Math.min(1, dot));
  const theta = theta0 * t;
  const sinTheta = Math.sin(theta);
  const sinTheta0 = Math.sin(theta0);
  const s0 = Math.cos(theta) - (dot * sinTheta) / sinTheta0;
  const s1 = sinTheta / sinTheta0;

  return [s0 * a[0] + s1 * bx, s0 * a[1] + s1 * by, s0 * a[2] + s1 * bz, s0 * a[3] + s1 * bw];
}

export function interpolatePose(a: Pose, b: Pose, alpha: number): Pose {
  const t = clamp01(alpha);
  if (t <= 0) return a;
  if (t >= 1) return b;
  return {
    position: lerpVec3(a.position, b.position, t),
    rotation: slerpQuat(a.rotation, b.rotation, t),
  };
}

function interpolateWheel(a: WheelState, b: WheelState, t: number): WheelState {
  return {
    position: lerpVec3(a.position, b.position, t),
    rotation: slerpQuat(a.rotation, b.rotation, t),
    steerRad: lerpNumber(a.steerRad, b.steerRad, t),
    spinRad: lerpNumber(a.spinRad, b.spinRad, t),
    inContact: b.inContact,
  };
}

function interpolateBeam(a: SensorBeam, b: SensorBeam, t: number): SensorBeam {
  const origin = lerpVec3(a.origin, b.origin, t);
  const direction = normalizeVec3(lerpVec3(a.direction, b.direction, t));
  const maxRangeM = lerpNumber(a.maxRangeM, b.maxRangeM, t);
  let hitM: number | null;
  if (a.hitM !== null && b.hitM !== null) {
    hitM = lerpNumber(a.hitM, b.hitM, t);
  } else {
    hitM = b.hitM;
  }
  return {
    origin,
    direction,
    maxRangeM,
    hitM,
  };
}

/**
 * Interpolates between two `StateSnapshot`s (`alpha` in `[0, 1]`).
 * At `alpha = 0` returns `prev`'s continuous pose/state; at `alpha = 1` returns `curr`.
 * Interpolates car pose, wheels, sensor beams, and obstacle poses with the same `alpha`
 * so beams and obstacles never lead or lag the car.
 */
export function interpolateSnapshots(
  prev: StateSnapshot,
  curr: StateSnapshot,
  alpha: number,
): StateSnapshot {
  const t = clamp01(alpha);
  if (t >= 1) return curr;
  if (t <= 0) return prev;

  const wheels: WheelState[] = curr.car.wheels.map((currWheel, i) => {
    const prevWheel = prev.car.wheels[i];
    return prevWheel ? interpolateWheel(prevWheel, currWheel, t) : currWheel;
  });

  const prevSensorsById = new Map(prev.sensors.map((s) => [s.instanceId, s]));
  const sensors = curr.sensors.map((currSensor) => {
    const prevSensor = prevSensorsById.get(currSensor.instanceId);
    if (!prevSensor) return currSensor;
    return {
      instanceId: currSensor.instanceId,
      beams: currSensor.beams.map((currBeam, i) => {
        const prevBeam = prevSensor.beams[i];
        return prevBeam ? interpolateBeam(prevBeam, currBeam, t) : currBeam;
      }),
    };
  });

  const prevObstaclesById = new Map(prev.obstacles.map((o) => [o.id, o]));
  const obstacles: ObstacleState[] = curr.obstacles.map((currObs) => {
    const prevObs = prevObstaclesById.get(currObs.id);
    if (!prevObs) return currObs;
    return {
      ...currObs,
      pose: interpolatePose(prevObs.pose, currObs.pose, t),
    };
  });

  return {
    tick: Math.round(lerpNumber(prev.tick, curr.tick, t)),
    timeUs: Math.round(lerpNumber(prev.timeUs, curr.timeUs, t)),
    status: curr.status,
    car: {
      pose: interpolatePose(prev.car.pose, curr.car.pose, t),
      velocity: lerpVec3(prev.car.velocity, curr.car.velocity, t),
      forwardSpeedMps: lerpNumber(prev.car.forwardSpeedMps, curr.car.forwardSpeedMps, t),
      command: {
        steerAngleRad: lerpNumber(
          prev.car.command.steerAngleRad,
          curr.car.command.steerAngleRad,
          t,
        ),
        motorDuty: lerpNumber(prev.car.command.motorDuty, curr.car.command.motorDuty, t),
      },
      wheels,
    },
    sensors,
    obstacles,
    laps: curr.laps,
    collisions: curr.collisions,
  };
}

/**
 * Holds the last two snapshots and interpolates between them for smooth 60 Hz
 * display even when snapshots arrive at a different rate.
 */
export class SnapshotInterpolator {
  #prev: StateSnapshot | null = null;
  #curr: StateSnapshot | null = null;
  #currAtMs = 0;
  #intervalMs = 1000 / 60;

  push(snapshot: StateSnapshot, receivedAtMs = performance.now()): void {
    if (this.#curr === null || snapshot.tick < this.#curr.tick || snapshot.status !== 'running') {
      // First snapshot, new run, or non-running snapshot (paused/stepped/ended): snap immediately
      this.#prev = snapshot;
      this.#curr = snapshot;
      this.#currAtMs = receivedAtMs;
      return;
    }

    const dt = receivedAtMs - this.#currAtMs;
    if (dt > 1 && dt < 1000) {
      this.#intervalMs = dt;
    }
    this.#prev = this.#curr;
    this.#curr = snapshot;
    this.#currAtMs = receivedAtMs;
  }

  reset(): void {
    this.#prev = null;
    this.#curr = null;
    this.#currAtMs = 0;
  }

  latest(): StateSnapshot | null {
    return this.#curr;
  }

  previous(): StateSnapshot | null {
    return this.#prev;
  }

  /**
   * Samples the interpolated snapshot at wall-clock time `nowMs` (for 60 Hz animation frames).
   * When `nowMs >= currAtMs + intervalMs` (or when only one snapshot exists), returns `curr` exact.
   */
  sample(nowMs = performance.now()): StateSnapshot | null {
    if (!this.#curr) return null;
    if (!this.#prev || this.#prev === this.#curr || this.#curr.status !== 'running') {
      return this.#curr;
    }
    const span = Math.max(1, this.#intervalMs);
    const alpha = clamp01((nowMs - this.#currAtMs) / span);
    return interpolateSnapshots(this.#prev, this.#curr, alpha);
  }
}
