import { describe, expect, it } from 'vitest';
import type { ActuatorSource, ScriptedPwm, TickInput } from '../api/actuator-source.ts';
import { createScriptedSource } from '../scenario/scripted-source.ts';
import { snapshotHash } from '../scenario/hash.ts';
import type { MeasuredRun } from './run.ts';
import {
  ARMED_BY_US,
  ESC_GPIO,
  NEUTRAL,
  STEERING_GPIO,
  runSeconds,
  steeringPulse,
  testRun,
  throttlePulse,
} from './test-support.ts';

const esc = (tUs: number, pulseUs: number): ScriptedPwm => ({ tUs, gpio: ESC_GPIO, pulseUs });
const BACK_US = 1360; // 100 µs past the backward edge of the deadband

/** Throttle, a turn, a brake, then the second tap into reverse. */
const MANOEUVRE: ScriptedPwm[] = [
  ...NEUTRAL,
  esc(ARMED_BY_US, throttlePulse(0.5)),
  { tUs: 5_000_000, gpio: STEERING_GPIO, pulseUs: steeringPulse(0.2) },
  esc(6_000_000, BACK_US),
  esc(7_500_000, 1500),
  esc(7_600_000, BACK_US),
];

/**
 * The snapshot hash of `MANOEUVRE` after 10 000 ticks of physics stage 2 on an
 * open oval, seed 7. Golden for the same reason as stage 1's (run.test.ts): CI
 * checks it on Linux x86-64 and macOS arm64. If you change stage 2 on purpose,
 * check the car still moves sensibly and paste the new hash.
 */
const STAGE_TWO_GOLDEN_HASH = '0800dadb50f976789d739756dc2f401c3bf1f279fa5471bab2a86730b087ff1e';

const manoeuvre = async (physicsStage?: 1 | 2): Promise<MeasuredRun> => {
  const run = await testRun({ timeline: MANOEUVRE, seed: 7, noWalls: true, physicsStage });
  await run.step(10_000);
  return run;
};

/** A scripted source that keeps every STEP input, to read what the firmware would. */
function recording(timeline: readonly ScriptedPwm[]): ActuatorSource & { inputs: TickInput[] } {
  const source = createScriptedSource(timeline);
  const inputs: TickInput[] = [];
  return {
    inputs,
    start: (setup) => source.start(setup),
    step(input) {
      inputs.push(input);
      return source.step(input);
    },
    stop: () => source.stop(),
  };
}

describe('stage-2 determinism', () => {
  it('repeats bit for bit, and matches the golden hash', async () => {
    const hashes: string[] = [];
    for (let i = 0; i < 2; i++) {
      const run = await manoeuvre(2);
      hashes.push(snapshotHash(run.snapshot()));
      expect(run.metrics().distanceM).toBeGreaterThan(3);
      await run.stop();
    }
    expect(hashes[1]).toBe(hashes[0]);
    expect(hashes[0]).toBe(STAGE_TWO_GOLDEN_HASH);
  }, 60_000);

  it('is not the default: no stage means stage 1', async () => {
    const hashes: string[] = [];
    for (const stage of [undefined, 1, 2] as const) {
      const run = await manoeuvre(stage);
      hashes.push(snapshotHash(run.snapshot()));
      await run.stop();
    }
    const [unset, one, two] = hashes;
    expect(unset).toBe(one);
    expect(two).not.toBe(one);
  }, 60_000);

  it('rejects a physics stage it does not know', async () => {
    await expect(testRun({ physicsStage: 3 as 2 })).rejects.toThrow(/physics stage/);
  });
});

describe('stage-2 ESC in a run', () => {
  it('brakes without backing up, then reverses on the second tap', async () => {
    const run = await testRun({ timeline: MANOEUVRE, noWalls: true, physicsStage: 2 });
    await runSeconds(run, 6);
    const driving = run.snapshot().car.forwardSpeedMps;
    expect(driving).toBeGreaterThan(1.5);
    let slowest = Infinity;
    for (let i = 0; i < 15; i++) {
      await runSeconds(run, 0.1);
      expect(run.snapshot().car.command).toMatchObject({ brake: true });
      slowest = Math.min(slowest, run.snapshot().car.forwardSpeedMps);
    }
    expect(slowest).toBeGreaterThan(-0.01);
    expect(run.snapshot().car.forwardSpeedMps).toBeLessThan(driving / 2);
    await runSeconds(run, 2.5);
    const { car } = run.snapshot();
    expect(car.command).not.toHaveProperty('brake');
    expect(car.command.motorDuty).toBeLessThan(0);
    expect(car.forwardSpeedMps).toBeLessThan(-0.5);
    await run.stop();
  }, 60_000);
});

describe('stage-2 battery voltage at the ADC', () => {
  const NOMINAL_ADC_V = (7.4 * 33_000) / 133_000;
  const launch = [...NEUTRAL, esc(ARMED_BY_US, 2000)];

  const adc = async (
    physicsStage: 1 | 2,
  ): Promise<{ tUs: number; volts: number; atTickUs: number }[]> => {
    const source = recording(launch);
    const run = await testRun({ source, noWalls: true, physicsStage });
    await runSeconds(run, 4.5);
    await run.stop();
    return source.inputs.flatMap((input) =>
      input.readings.flatMap((r) =>
        r.instanceId === 'battery_sense' && r.type === 'analog'
          ? [{ tUs: r.tUs, volts: r.volts, atTickUs: input.t0Us }]
          : [],
      ),
    );
  };

  it('reads the open-circuit voltage unloaded, and sags under motor load', async () => {
    const readings = await adc(2);
    const unloaded = readings.filter((r) => r.tUs < ARMED_BY_US);
    expect(unloaded.length).toBeGreaterThan(0);
    for (const r of unloaded) expect(r.volts).toBeCloseTo(NOMINAL_ADC_V, 9);
    const loaded = readings.filter((r) => r.tUs > ARMED_BY_US);
    const lowest = Math.min(...loaded.map((r) => r.volts));
    // 12 mΩ and some tens of amps: at least 0.3 V at the pack
    expect(lowest).toBeLessThan(NOMINAL_ADC_V - (0.3 * 33) / 133);
    // and it recovers as the motor speeds up
    expect(loaded.at(-1)!.volts).toBeGreaterThan(lowest + 0.02);
    expect(loaded.at(-1)!.volts).toBeLessThan(NOMINAL_ADC_V);
  }, 60_000);

  it('samples every 10 ms, so a launch is seen as it happens', async () => {
    const readings = await adc(2);
    expect(readings[1]!.tUs - readings[0]!.tUs).toBe(10_000);
    const first = readings.find((r) => r.volts < NOMINAL_ADC_V - 0.05)!;
    expect(first.atTickUs - ARMED_BY_US).toBeLessThan(40_000);
  }, 60_000);

  it('stays constant, ten times a second, in stage 1', async () => {
    const readings = await adc(1);
    expect(readings[1]!.tUs - readings[0]!.tUs).toBe(100_000);
    for (const r of readings) expect(r.volts).toBeCloseTo(NOMINAL_ADC_V, 9);
  }, 60_000);
});
