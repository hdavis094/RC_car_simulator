// Helpers shared by sim-core's tests. Not part of the package's public API.
import { defaultCatalog, exampleCar, World, type Obstacle } from '@rcsim/schema';
import type { ActuatorSource, ScriptedPwm } from '../api/actuator-source.ts';
import type { Run } from '../api/run.ts';
import { createScriptedSource } from '../scenario/scripted-source.ts';
import { trackLibrary } from '../world/track-library.ts';
import { createRun, type MeasuredRun } from './run.ts';

/** The default car's actuator pins (examples/default-car.json). */
export const ESC_GPIO = 26;
export const STEERING_GPIO = 25;

export interface TestRunOptions {
  readonly trackId?: string;
  readonly start?: { x: number; z: number; yawDeg: number };
  readonly obstacles?: readonly Obstacle[];
  readonly seed?: number;
  readonly tickUs?: number;
  readonly timeline?: readonly ScriptedPwm[];
  readonly source?: ActuatorSource;
  /** Remove the track walls (an open floor). */
  readonly noWalls?: boolean;
}

export function testWorldFile(options: TestRunOptions = {}): World {
  return World.parse({
    schemaVersion: 1,
    name: 'test',
    trackId: options.trackId ?? 'oval',
    seed: options.seed ?? 1,
    obstacles: options.obstacles ?? [],
    ...(options.start
      ? {
          start: {
            positionM: { x: options.start.x, z: options.start.z },
            yawDeg: options.start.yawDeg,
          },
        }
      : {}),
  });
}

/** A run of the default car on a built-in track, driven by a timeline (or a given source). */
export function testRun(options: TestRunOptions = {}): Promise<MeasuredRun> {
  const track = trackLibrary.load(options.trackId ?? 'oval');
  return createRun({
    car: exampleCar,
    catalog: defaultCatalog,
    world: testWorldFile(options),
    track: options.noWalls ? { ...track, wallHeightM: 0 } : track,
    seed: options.seed ?? 1,
    ...(options.tickUs !== undefined ? { tickUs: options.tickUs } : {}),
    source: options.source ?? createScriptedSource(options.timeline ?? []),
  });
}

/** Neutral on both channels from t = 0. */
export const NEUTRAL: readonly ScriptedPwm[] = [
  { tUs: 0, gpio: ESC_GPIO, pulseUs: 1500 },
  { tUs: 0, gpio: STEERING_GPIO, pulseUs: 1500 },
];

/** ESC arming time of the default ESC, µs, with a margin. */
export const ARMED_BY_US = 3_200_000;

/** ESC pulse for a given motor duty (1500 µs neutral, 40 µs deadband, 1000..2000 range). */
export const throttlePulse = (duty: number): number => Math.round(1540 + duty * 460);

/** Steering servo pulse for a steering angle in radians, positive left (MG996R, linkage ratio 0.7). */
export function steeringPulse(steerAngleRad: number): number {
  const servoDeg = (-steerAngleRad * 180) / Math.PI / 0.7;
  return Math.round(1500 + (servoDeg / 159) * 2000);
}

export async function runSeconds(run: Run, seconds: number): Promise<void> {
  await run.step(Math.round((seconds * 1_000_000) / run.clock.tickUs));
}
