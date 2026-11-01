/**
 * The only source of time in sim-core (AGENTS.md → Determinism). A tick is
 * `tickUs` of sim time, 1000 µs by default. Nothing in sim-core may read the
 * wall clock.
 */
export interface SimClock {
  readonly tickUs: number;
  /** Ticks completed since the run started. */
  readonly tick: number;
  /** Sim time at the start of the current tick, µs: `tick × tickUs`. */
  readonly nowUs: number;
  /** Ends the current tick. Called once per tick by the Run, nobody else. */
  advance(): void;
}

/**
 * A deterministic random stream: the same seed and stream name give the same
 * sequence on every platform. Uniform draws use integer arithmetic only;
 * `normal()` may use Math functions, which V8 computes identically everywhere.
 */
export interface Rng {
  /** Uniform in [0, 1). */
  next(): number;
  /** Uniform integer in [0, n). */
  int(n: number): number;
  /** Standard normal (mean 0, σ 1). */
  normal(): number;
}

/**
 * The run's seeded randomness, split into named streams so that adding a
 * sensor never shifts another sensor's noise. Name a stream after what uses
 * it: `sensor:tof_left`, `sensor:imu:bias`, `world:obstacles`.
 */
export interface RngStreams {
  readonly seed: number;
  /** The stream for `name`; the same object on every call with that name. */
  stream(name: string): Rng;
}
