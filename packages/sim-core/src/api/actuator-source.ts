import type { Car, Catalog } from '@rcsim/schema';
import type {
  Device,
  GpioEdge,
  GpioWrite,
  LogLine,
  NetEvent,
  NetFaults,
  PwmOutput,
} from '@rcsim/sim-protocol';
import type { SensorReading } from './sensors.ts';

/** What the Run hands an actuator source before the first tick. */
export interface ActuatorSourceSetup {
  readonly car: Car;
  readonly catalog: Catalog;
  readonly seed: number;
  readonly tickUs: number;
  /** The sim-protocol device table, in car.json order (index = device id). */
  readonly devices: readonly Device[];
}

/** Inputs for one tick, the content of a sim-protocol STEP. */
export interface TickInput {
  readonly tick: number;
  readonly t0Us: number;
  readonly t1Us: number;
  /** Readings produced during the previous tick, tagged with their part: in car.json order, then by tUs. */
  readonly readings: readonly (SensorReading & { readonly instanceId: string })[];
  /** Input edges within [t0Us, t1Us), merged from all sensors in ascending tUs (ties in car.json order). */
  readonly gpioEdges: readonly GpioEdge[];
  readonly serialRx: Uint8Array;
  readonly netFaults?: NetFaults | undefined;
}

/** Outputs of one tick, the content of a sim-protocol STEP_DONE. */
export interface TickOutput {
  /** PWM channels that changed during the tick. */
  readonly pwm: readonly PwmOutput[];
  readonly gpioWrites: readonly GpioWrite[];
  readonly serialTx: Uint8Array;
  readonly netEvents: readonly NetEvent[];
  readonly logs: readonly LogLine[];
}

/** Why an actuator source stopped producing ticks. */
export type SourceEnd =
  | { readonly kind: 'finished' }
  | { readonly kind: 'stalled'; readonly afterMs: number }
  | {
      readonly kind: 'crashed';
      readonly exitCode: number | null;
      readonly signal: string | null;
      /** The last lines of the firmware's stderr. */
      readonly stderrTail: readonly string[];
    }
  | { readonly kind: 'error'; readonly message: string };

/** Thrown by `step` when the source can't continue. */
export class ActuatorSourceEnded extends Error {
  readonly end: SourceEnd;
  constructor(end: SourceEnd) {
    super(`actuator source ended: ${end.kind}`);
    this.name = 'ActuatorSourceEnded';
    this.end = end;
  }
}

/**
 * Where PWM and GPIO outputs come from: the firmware bridge (P1-H, a real
 * firmware process over sim-protocol) or a scripted timeline for tests
 * (P1-A). The Run calls `start` once, then `step` once per tick, in order.
 */
export interface ActuatorSource {
  start(setup: ActuatorSourceSetup): Promise<void>;
  /** Runs one tick; rejects with `ActuatorSourceEnded` when the source is done. */
  step(input: TickInput): Promise<TickOutput>;
  /** Ends the source (kills the firmware). Safe to call twice. */
  stop(): Promise<void>;
  /**
   * Restarts the firmware while the world carries on, as an ESP32 reboot
   * would (a new sim-protocol connection; `setup()` runs again at the current
   * tick). Optional: scripted sources don't have one.
   */
  restart?(): Promise<void>;
}

export interface FirmwareSourceOptions {
  /** The firmware binary built by hal's build-sim (`.rcsim/build/firmware`). */
  readonly binary: string;
  /** Working directory for the process; default the binary's project. */
  readonly cwd?: string;
  /** Wall-clock stall timeout; default 2000 ms. */
  readonly stallTimeoutMs?: number;
  /** Bind address for firmware servers, sent in CONFIG; default 127.0.0.1. */
  readonly bindAddress?: string;
}

/** The firmware bridge's source (sim-core/src/bridge). Implemented by P1-H. */
export type CreateFirmwareSource = (options: FirmwareSourceOptions) => ActuatorSource;

/** A scripted PWM change: at `tUs`, `gpio` starts outputting `pulseUs` (50 Hz). */
export interface ScriptedPwm {
  readonly tUs: number;
  readonly gpio: number;
  readonly pulseUs: number;
  /** Default 20 000 (50 Hz). */
  readonly periodUs?: number;
}

/** Builds a scripted source from a timeline (`--script timeline.json`). Implemented by P1-A. */
export type CreateScriptedSource = (timeline: readonly ScriptedPwm[]) => ActuatorSource;
