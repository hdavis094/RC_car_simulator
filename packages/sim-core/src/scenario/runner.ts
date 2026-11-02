import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Car, World, defaultCatalog, type Catalog } from '@rcsim/schema';
import type { ActuatorSource, ScriptedPwm } from '../api/actuator-source.ts';
import type { RunEnd } from '../api/run.ts';
import {
  SCENARIO_METRICS,
  type ScenarioAssertion,
  type ScenarioMetric,
  type ScenarioResult,
  type ScenarioSpec,
} from '../api/scenario.ts';
import { createRun } from '../run/run.ts';
import { trackLibrary } from '../world/track-library.ts';
import { snapshotHash } from './hash.ts';
import { createScriptedSource } from './scripted-source.ts';

export interface ScenarioIo {
  /** Directory the spec's relative paths are resolved from. Default the process's. */
  readonly cwd?: string;
  /** Parts catalog; default the built-in one. */
  readonly catalog?: Catalog;
  /**
   * Builds the source for specs with `firmware` set. The firmware bridge
   * (P1-H) provides it; without one, `firmware` is an error.
   */
  readonly createFirmwareSource?: (spec: ScenarioSpec) => ActuatorSource | Promise<ActuatorSource>;
}

/** An input file that is missing or malformed (the CLI reports it, exit code 2). */
export class ScenarioInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScenarioInputError';
  }
}

async function readJson(file: string, what: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    throw new ScenarioInputError(`cannot read ${what} "${file}": ${(error as Error).message}`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new ScenarioInputError(`${what} "${file}" is not JSON: ${(error as Error).message}`);
  }
}

function parseWith<T>(schema: { parse(value: unknown): T }, value: unknown, what: string): T {
  try {
    return schema.parse(value);
  } catch (error) {
    throw new ScenarioInputError(`invalid ${what}: ${(error as Error).message}`);
  }
}

/** Reads and checks a world file (relative paths resolve from `io.cwd`). */
export async function readWorld(file: string, io: ScenarioIo = {}): Promise<World> {
  const resolved = path.resolve(io.cwd ?? process.cwd(), file);
  return parseWith(World, await readJson(resolved, 'world'), `world "${file}"`);
}

/** Reads a `--script` file: a JSON array of `{tUs, gpio, pulseUs, periodUs?}`. */
export function parseTimeline(value: unknown): ScriptedPwm[] {
  if (!Array.isArray(value)) throw new ScenarioInputError('a script must be a JSON array');
  return value.map((entry: unknown, i): ScriptedPwm => {
    const e = entry as Partial<ScriptedPwm> | null;
    const ok =
      typeof e === 'object' &&
      e !== null &&
      Number.isFinite(e.tUs) &&
      (e.tUs ?? -1) >= 0 &&
      Number.isInteger(e.gpio) &&
      Number.isFinite(e.pulseUs) &&
      (e.periodUs === undefined || Number.isFinite(e.periodUs));
    if (!ok) {
      throw new ScenarioInputError(
        `script entry ${i} must be {tUs >= 0, gpio (integer), pulseUs, periodUs?}, got ${JSON.stringify(entry)}`,
      );
    }
    return e as ScriptedPwm;
  });
}

const compare: Record<ScenarioAssertion['op'], (a: number, b: number) => boolean> = {
  '==': (a, b) => a === b,
  '!=': (a, b) => a !== b,
  '<': (a, b) => a < b,
  '<=': (a, b) => a <= b,
  '>': (a, b) => a > b,
  '>=': (a, b) => a >= b,
};

/** Runs a scenario headless: the sim for `seconds` of sim time, then the assertions. */
export async function runScenario(
  spec: ScenarioSpec,
  io: ScenarioIo = {},
): Promise<ScenarioResult> {
  if (spec.tickUs !== undefined && (!Number.isInteger(spec.tickUs) || spec.tickUs <= 0)) {
    throw new ScenarioInputError(`tickUs must be a positive integer, got ${spec.tickUs}`);
  }
  if (!Number.isFinite(spec.seconds) || spec.seconds < 0) {
    throw new ScenarioInputError(`seconds must be a non-negative number, got ${spec.seconds}`);
  }
  const at = (file: string): string => path.resolve(io.cwd ?? process.cwd(), file);
  const car = parseWith(Car, await readJson(at(spec.car), 'car'), `car "${spec.car}"`);
  const world = await readWorld(spec.world, io);
  const track = trackLibrary.load(world.trackId);

  let source: ActuatorSource;
  if (spec.firmware !== undefined) {
    if (!io.createFirmwareSource) {
      throw new ScenarioInputError(
        '--firmware needs the firmware bridge, which is not available here',
      );
    }
    source = await io.createFirmwareSource(spec);
  } else if (spec.script !== undefined) {
    source = createScriptedSource(parseTimeline(await readJson(at(spec.script), 'script')));
  } else {
    throw new ScenarioInputError('give --script <timeline.json> (or --firmware <binary>)');
  }

  const started = performance.now();
  const run = await createRun({
    car,
    catalog: io.catalog ?? defaultCatalog,
    world,
    track,
    seed: spec.seed,
    ...(spec.tickUs !== undefined ? { tickUs: spec.tickUs } : {}),
    source,
  });
  const ticks = Math.round((spec.seconds * 1_000_000) / run.clock.tickUs);
  try {
    // In slices, so a long scenario doesn't hold one enormous promise chain.
    for (let done = 0; done < ticks && run.status !== 'ended';) {
      const slice = Math.min(1000, ticks - done);
      const result = await run.step(slice);
      done += result.ticks;
    }
  } finally {
    await run.stop();
  }
  const end: RunEnd = run.end ?? { kind: 'stopped' };

  const m = run.metrics();
  const metrics = Object.fromEntries(SCENARIO_METRICS.map((name) => [name, m[name]])) as Record<
    ScenarioMetric,
    number
  >;
  const assertions = spec.assertions.map((a) => {
    const actual = metrics[a.metric];
    return { ...a, actual, passed: compare[a.op](actual, a.value) };
  });
  // A run that ended on a source failure is a failed scenario, assertions or not.
  const healthy = end.kind === 'stopped' || end.kind === 'finished';
  return {
    passed: healthy && assertions.every((a) => a.passed),
    metrics,
    assertions,
    end,
    snapshotHash: snapshotHash(run.snapshot()),
    wallMs: Math.round(performance.now() - started),
  };
}
