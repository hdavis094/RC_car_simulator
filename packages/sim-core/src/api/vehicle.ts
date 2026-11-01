import type { Car, Catalog } from '@rcsim/schema';
import type { Pose, Quat, Vec3 } from './math.ts';

/** What the vehicle is built from. */
export interface VehicleSpec {
  readonly car: Car;
  readonly catalog: Catalog;
}

/**
 * The physical command after the actuator models: what the steering linkage
 * and the motor actually do this tick.
 */
export interface VehicleCommand {
  /**
   * Front-wheel steering angle, radians, positive turning left (like yaw).
   * Ackermann: this is the angle of a virtual centre wheel; the inner and
   * outer wheels follow from the chassis geometry.
   */
  readonly steerAngleRad: number;
  /** Motor drive, −1..1: fraction of battery voltage, negative for reverse/brake. */
  readonly motorDuty: number;
}

/** Wheels in a fixed order: front-left, front-right, rear-left, rear-right. */
export const WHEEL_ORDER = ['front-left', 'front-right', 'rear-left', 'rear-right'] as const;

export interface WheelState {
  readonly position: Vec3;
  readonly rotation: Quat;
  /** Steering angle of this wheel, radians, positive left. */
  readonly steerRad: number;
  /** Accumulated spin, radians (for drawing). */
  readonly spinRad: number;
  readonly inContact: boolean;
}

export interface VehicleState {
  /** Chassis-frame origin in the world: on the ground, midway between the axles. */
  readonly pose: Pose;
  /** World-frame linear velocity, m/s. */
  readonly velocity: Vec3;
  /** World-frame angular velocity, rad/s. */
  readonly angularVelocity: Vec3;
  /** Signed speed along the car's forward axis, m/s. */
  readonly forwardSpeedMps: number;
  /** World-frame linear acceleration, m/s², over the last step (for the IMU). */
  readonly acceleration: Vec3;
  /** The command applied in the last step. */
  readonly command: VehicleCommand;
  /** In WHEEL_ORDER. */
  readonly wheels: readonly [WheelState, WheelState, WheelState, WheelState];
}

/** The car's body in the world. Created by `World.createVehicle`. */
export interface Vehicle {
  /** Sets the command used by the next `World.step`. */
  applyCommand(command: VehicleCommand): void;
  /** State after the last `World.step`. */
  state(): VehicleState;
  /**
   * World pose of a point fixed to the chassis: a mount point plus a
   * placement, in chassis-frame mm and degrees (schema conventions).
   */
  chassisToWorld(
    offsetMm: { x: number; y: number; z: number },
    yawDeg: number,
    pitchDeg: number,
  ): Pose;
}
