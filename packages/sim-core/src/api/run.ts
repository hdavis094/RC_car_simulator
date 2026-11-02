import type { Car, Catalog, Track, World as WorldFile } from '@rcsim/schema';
import type { LogLine, NetEvent, NetFaults } from '@rcsim/sim-protocol';
import type { ActuatorSource, SourceEnd } from './actuator-source.ts';
import type { CreateActuatorModel } from './actuators.ts';
import type { SimClock } from './clock.ts';
import type { CreateSensorModel } from './sensors.ts';
import type { StateSnapshot } from './snapshot.ts';
import type { World } from './world.ts';

/** `ready` before the first tick, `running` once stepped, `ended` when the source ended or `stop()` ran. */
export type RunStatus = 'ready' | 'running' | 'ended';

/** Why a run ended. */
export type RunEnd = SourceEnd | { readonly kind: 'stopped' };

export interface RunOptions {
  readonly car: Car;
  readonly catalog: Catalog;
  readonly world: WorldFile;
  readonly track: Track;
  readonly seed: number;
  /** Default 1000. */
  readonly tickUs?: number;
  readonly source: ActuatorSource;
  /** Model factories; defaults are sim-core's own (P1-A actuators, P1-B sensors). Override to fake a neighbour. */
  readonly createActuatorModel?: CreateActuatorModel;
  readonly createSensorModel?: CreateSensorModel;
}

export interface RunStepResult {
  /** Ticks actually run (fewer than asked when the run ended). */
  readonly ticks: number;
  readonly status: RunStatus;
  readonly end: RunEnd | null;
}

export interface RunEvents {
  /** Bytes the firmware wrote to Serial during a tick. */
  serial: (bytes: Uint8Array, tUs: number) => void;
  log: (line: LogLine, tUs: number) => void;
  net: (event: NetEvent, tUs: number) => void;
  end: (end: RunEnd) => void;
}

export type Unsubscribe = () => void;

/**
 * One run: firmware (or a script) driving a car in a world, tick by tick.
 * Each tick, in this order:
 *
 *   1. `source.step` with STEP inputs (readings from the previous tick, GPIO
 *      edges, serial RX), giving STEP_DONE outputs;
 *   2. PWM changes into the actuator models; GPIO writes to the sensor models
 *      that own those pins;
 *   3. actuator models → `vehicle.applyCommand`;
 *   4. `world.step` (physics), collisions and laps counted;
 *   5. every sensor model's `update`, readings kept for the next tick's STEP;
 *   6. `clock.advance()`.
 *
 * A Run is not paced: `step` runs as fast as it can. Pause, single-step and
 * speed are the caller's (the app's SimService paces to the wall clock).
 *
 * Lifecycle: never call `step` while a previous `step` is pending. `stop()`
 * may be called at any time, including during `step`; that `step` then
 * resolves with status `ended` and runs no further ticks. A run ends exactly
 * once: `end` is set and the `end` event fires once, with the first reason
 * (`stopped` wins over a failure the stop itself causes). An unexpected error
 * from a part of the loop ends the run with `{kind: 'error'}`, rather than
 * rejecting `step`. However a run ended, call `stop()` to release the source.
 * An `end` listener that throws affects neither the run nor other listeners.
 */
export interface Run {
  readonly clock: SimClock;
  readonly world: World;
  readonly status: RunStatus;
  readonly end: RunEnd | null;
  /** Runs up to `ticks` ticks (default 1); resolves early if the run ends. */
  step(ticks?: number): Promise<RunStepResult>;
  snapshot(): StateSnapshot;
  /** Queues bytes for the firmware's Serial RX in the next tick. */
  sendSerial(bytes: Uint8Array): void;
  /** Network fault injection, sent to hal in the next STEP. */
  setNetFaults(faults: NetFaults): void;
  on<E extends keyof RunEvents>(event: E, listener: RunEvents[E]): Unsubscribe;
  /**
   * Reboots the firmware while the world carries on (`ActuatorSource.restart`).
   * Rejects if the source can't restart (a scripted source).
   */
  restartFirmware(): Promise<void>;
  /** Ends the run and the source. */
  stop(): Promise<void>;
}

/** Assembles a run. Implemented by P1-A. */
export type CreateRun = (options: RunOptions) => Promise<Run>;
