import type { Pose, Vec3 } from './math.ts';
import type { SensorBeam } from './sensors.ts';
import type { VehicleCommand, WheelState } from './vehicle.ts';
import type { ObstacleState } from './world.ts';
import type { RunStatus } from './run.ts';

/**
 * What the renderer draws, sent from the sim host at about 60 Hz. Plain data
 * only (tuples, no classes or typed arrays), so it survives IPC and
 * structuredClone. The renderer never owns sim state; it interpolates
 * between the last two snapshots it received.
 */
export interface StateSnapshot {
  readonly tick: number;
  /** Sim time, µs. */
  readonly timeUs: number;
  readonly status: RunStatus;
  readonly car: {
    readonly pose: Pose;
    readonly velocity: Vec3;
    readonly forwardSpeedMps: number;
    readonly command: VehicleCommand;
    /** front-left, front-right, rear-left, rear-right. */
    readonly wheels: readonly WheelState[];
  };
  /** Distance-sensor beams, by part. */
  readonly sensors: readonly {
    readonly instanceId: string;
    readonly beams: readonly SensorBeam[];
  }[];
  readonly obstacles: readonly ObstacleState[];
  readonly laps: {
    readonly count: number;
    /** Sim time of each completed lap, µs, measured from the run start for the first. */
    readonly lapTimesUs: readonly number[];
  };
  readonly collisions: {
    readonly count: number;
    /** Obstacle id or "wall" of the most recent collision. */
    readonly last: string | null;
  };
}
