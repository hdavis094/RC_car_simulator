import type { RunEnd } from './run.ts';

/** A number a scenario can assert on. */
export type ScenarioMetric = 'collisions' | 'laps' | 'maxSpeedMps' | 'distanceM' | 'simSeconds';

export interface ScenarioAssertion {
  readonly metric: ScenarioMetric;
  readonly op: '==' | '!=' | '<' | '<=' | '>' | '>=';
  readonly value: number;
}

/**
 * A headless run with fixed inputs and assertions (GLOSSARY → Scenario).
 * Paths are relative to the working directory. Exactly one of `script` and
 * `firmware` drives the car.
 */
export interface ScenarioSpec {
  readonly car: string;
  readonly world: string;
  readonly seconds: number;
  readonly seed: number;
  readonly tickUs?: number;
  /** Scripted PWM timeline (JSON array of ScriptedPwm). */
  readonly script?: string;
  /** Firmware binary built by hal's build-sim (P1-H). */
  readonly firmware?: string;
  /** Control-protocol lines sent to the firmware at fixed sim times (P1-H). */
  readonly control?: string;
  readonly assertions: readonly ScenarioAssertion[];
}

export interface ScenarioResult {
  readonly passed: boolean;
  readonly metrics: Readonly<Record<ScenarioMetric, number>>;
  readonly assertions: readonly (ScenarioAssertion & {
    readonly actual: number;
    readonly passed: boolean;
  })[];
  readonly end: RunEnd;
  /** Hash of the final snapshot, to compare runs for determinism. */
  readonly snapshotHash: string;
  readonly wallMs: number;
}

/**
 * Parses an assertion like `laps >= 1` or `maxSpeed < 3` (CLI `--assert`).
 * Speeds are m/s, distances metres. Throws on a bad expression.
 */
export function parseAssertion(text: string): ScenarioAssertion {
  const match = /^\s*([a-zA-Z]+)\s*(==|!=|<=|>=|<|>)\s*(-?\d+(?:\.\d+)?)\s*$/.exec(text);
  const metrics: readonly string[] = [
    'collisions',
    'laps',
    'maxSpeedMps',
    'distanceM',
    'simSeconds',
  ];
  // Short names the CLI accepts too (P1-A's brief writes `maxSpeed < x`).
  const aliases: Readonly<Record<string, ScenarioMetric>> = {
    maxSpeed: 'maxSpeedMps',
    distance: 'distanceM',
  };
  const name = match ? (aliases[match[1] ?? ''] ?? match[1] ?? '') : '';
  if (!match || !metrics.includes(name)) {
    throw new Error(`bad assertion "${text}": expected "<${metrics.join('|')}> <op> <number>"`);
  }
  return {
    metric: name as ScenarioMetric,
    op: match[2] as ScenarioAssertion['op'],
    value: Number(match[3]),
  };
}
