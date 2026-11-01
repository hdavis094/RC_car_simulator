import type { BehaviorTemplate } from '@rcsim/schema';
import type { GpioEdge, GpioWrite, Reading } from '@rcsim/sim-protocol';
import type { Rng } from './clock.ts';
import type { Vec3 } from './math.ts';
import type { PartContext } from './parts.ts';
import type { VehicleState } from './vehicle.ts';
import type { World } from './world.ts';

/**
 * A reading as a sensor model produces it: a sim-protocol reading without
 * the device index (the bridge adds it). `tUs` is when the part produced it.
 */
export type SensorReading = Reading extends infer R
  ? R extends Reading
    ? Omit<R, 'device'>
    : never
  : never;

/** Everything a sensor model may read during one tick. */
export interface SensorContext {
  /** Sim time at the end of the physics step just taken, µs. */
  readonly nowUs: number;
  readonly dtUs: number;
  readonly world: World;
  readonly vehicle: VehicleState;
  /** This sensor's own stream (`sensor:<instanceId>`); never share it. */
  readonly rng: Rng;
}

/** One ray of a sensor, for drawing in the 3D World. */
export interface SensorBeam {
  readonly origin: Vec3;
  /** Unit vector. */
  readonly direction: Vec3;
  readonly maxRangeM: number;
  /** Distance to the hit, or null for no hit in range. */
  readonly hitM: number | null;
}

/**
 * Computes what a sensor part measures (ARCHITECTURE.md → Sensors and
 * actuators): range limits, beam width, noise from its own Rng, and its
 * update rate. One instance per sensor part, created per run.
 */
export interface SensorModel {
  readonly instanceId: string;
  readonly template: BehaviorTemplate;
  /**
   * Called once per tick after physics. Returns the readings the part
   * produced during the tick (usually none or one; empty between updates).
   */
  update(context: SensorContext): readonly SensorReading[];
  /**
   * A GPIO the firmware wrote that belongs to this part (an HC-SR04 TRIG).
   * Edges arrive in time order.
   */
  onGpioWrite?(write: GpioWrite): void;
  /**
   * Input edges this part drives on its GPIOs within [t0Us, t1Us) (an
   * HC-SR04 ECHO), in time order. Each edge is returned once.
   */
  takeGpioEdges?(t0Us: number, t1Us: number): readonly GpioEdge[];
  /** Current beams for the snapshot (distance sensors); empty for others. */
  beams(): readonly SensorBeam[];
}

/**
 * Builds the model for a sensor part (`distance-raycast`, `imu`, or a
 * `voltage-divider` reading the battery). Implemented by P1-B.
 */
export type CreateSensorModel = (part: PartContext) => SensorModel;
