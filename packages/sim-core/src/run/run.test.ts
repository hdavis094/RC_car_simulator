import { describe, expect, it } from 'vitest';
import type { ScriptedPwm } from '../api/actuator-source.ts';
import { snapshotHash } from '../scenario/hash.ts';
import { yawOf } from '../world/quat.ts';
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
import { recordLap } from './test-lap-driver.ts';

const drive = (duty: number, fromUs = ARMED_BY_US): ScriptedPwm[] => [
  ...NEUTRAL,
  { tUs: fromUs, gpio: ESC_GPIO, pulseUs: throttlePulse(duty) },
];

/**
 * A drive that matters: neutral through arming, then throttle, then a gentle
 * left turn that follows the oval's end. Everything is applied after the ESC
 * has armed (3 s), so the car really moves.
 */
const DRIVEN: ScriptedPwm[] = [
  ...NEUTRAL,
  { tUs: ARMED_BY_US, gpio: ESC_GPIO, pulseUs: throttlePulse(0.25) },
  { tUs: 5_700_000, gpio: STEERING_GPIO, pulseUs: steeringPulse(0.14) },
];

/**
 * The snapshot hash of `DRIVEN` after 10 000 ticks on the oval, seed 7. A
 * golden value: `pnpm verify` runs this on Linux x86-64 and on macOS arm64
 * (CI), so it checks the physics, Rapier's WebAssembly and V8's Math give
 * bit-identical runs across them. It covers Node's V8, not Electron's.
 * If you change the physics on purpose, run the test, check the car still
 * moves sensibly, and paste the new hash from the failure message.
 */
const DRIVEN_GOLDEN_HASH = '3dbab6470d45dfe28f0d6a3f9c69d2ed88a2a38d30f55b5ac35e84625f4fe1e8';

describe('determinism', () => {
  async function drivenRun(): Promise<MeasuredRun> {
    const run = await testRun({ timeline: DRIVEN, seed: 7 });
    await run.step(10_000);
    return run;
  }

  it('drives the car, so the hash means something', async () => {
    const run = await drivenRun();
    const m = run.metrics();
    expect(m.distanceM).toBeGreaterThan(8);
    expect(m.maxSpeedMps).toBeGreaterThan(1.5);
    expect(m.collisions).toBe(0);
    const { pose } = run.snapshot().car;
    expect(pose.position[0]).toBeLessThan(2); // it left the straight and is round the bend
    expect(Math.abs(yawOf(pose.rotation))).toBeGreaterThan(1); // it turned
    await run.stop();
  }, 30_000);

  it('gives bit-identical snapshot hashes for the same inputs and seed', async () => {
    const hashes: string[] = [];
    for (let i = 0; i < 2; i++) {
      const run = await drivenRun();
      hashes.push(snapshotHash(run.snapshot()));
      await run.stop();
    }
    expect(hashes[0]).toBe(hashes[1]);
  }, 30_000);

  it('gives a different hash for a different drive', async () => {
    const run = await testRun({
      timeline: [...DRIVEN, { tUs: 6_000_000, gpio: ESC_GPIO, pulseUs: 1500 }],
      seed: 7,
    });
    await run.step(10_000);
    expect(snapshotHash(run.snapshot())).not.toBe(DRIVEN_GOLDEN_HASH);
    await run.stop();
  }, 30_000);

  it('matches the golden hash, on every platform CI runs', async () => {
    const run = await drivenRun();
    expect(snapshotHash(run.snapshot())).toBe(DRIVEN_GOLDEN_HASH);
    await run.stop();
  }, 30_000);
});

describe('ESC arming', () => {
  it('produces no motion for a throttle pulse sent before neutral has been held long enough', async () => {
    // Neutral for 1 s, then throttle: the ESC is not armed (3 s needed) and never arms.
    const run = await testRun({
      timeline: [...NEUTRAL, { tUs: 1_000_000, gpio: ESC_GPIO, pulseUs: 1700 }],
    });
    await runSeconds(run, 8);
    const m = run.metrics();
    expect(m.distanceM).toBeLessThan(0.005);
    expect(m.maxSpeedMps).toBeLessThan(0.01);
    await run.stop();
  }, 30_000);

  it('moves once neutral has been held for the arming time', async () => {
    const run = await testRun({ timeline: drive(0.3) });
    await runSeconds(run, 6);
    expect(run.metrics().distanceM).toBeGreaterThan(1);
    await run.stop();
  }, 30_000);

  it('restarts the wait when a throttle pulse interrupts neutral', async () => {
    const run = await testRun({
      timeline: [
        ...NEUTRAL,
        { tUs: 2_000_000, gpio: ESC_GPIO, pulseUs: 1700 }, // blip at 2 s: not armed yet
        { tUs: 2_100_000, gpio: ESC_GPIO, pulseUs: 1500 },
        { tUs: 4_000_000, gpio: ESC_GPIO, pulseUs: 1700 }, // 1.9 s after the blip: still not armed
      ],
    });
    await runSeconds(run, 5);
    expect(run.metrics().distanceM).toBeLessThan(0.005);
    await run.stop();
  }, 30_000);
});

describe('collisions', () => {
  it('reports exactly one collision for a straight run into a cone', async () => {
    const run = await testRun({
      start: { x: 2.4, z: 0, yawDeg: 0 },
      obstacles: [{ id: 'cone-1', type: 'cone', positionM: { x: 2.4, z: -2 }, yawDeg: 0 }],
      timeline: drive(0.3),
    });
    // The cone is 2 m ahead; at ~2 m/s the car reaches it shortly after arming. Keep pushing.
    await runSeconds(run, 9);
    expect(run.snapshot().collisions).toEqual({ count: 1, last: 'cone-1' });
    expect(run.metrics().collisions).toBe(1);
    await run.stop();
  }, 30_000);

  it('reports no collision while the car stays clear of a cone', async () => {
    const run = await testRun({
      start: { x: 2.4, z: 0, yawDeg: 0 },
      obstacles: [{ id: 'cone-1', type: 'cone', positionM: { x: 2.4, z: -2 }, yawDeg: 0 }],
      timeline: [...drive(0.3), { tUs: 3_400_000, gpio: ESC_GPIO, pulseUs: 1500 }],
    });
    await runSeconds(run, 6);
    expect(run.metrics().collisions).toBe(0);
    await run.stop();
  }, 30_000);

  it('reports a wall hit once, not once per wall piece', async () => {
    // Straight into the oval's far end wall.
    const run = await testRun({
      start: { x: 0, z: 0, yawDeg: 0 },
      timeline: drive(0.5, 3_200_000),
    });
    await runSeconds(run, 12);
    expect(run.snapshot().collisions).toEqual({ count: 1, last: 'wall' });
    await run.stop();
  }, 30_000);
});

describe('laps', () => {
  it('counts one lap for a scripted timeline that completes the oval', async () => {
    const { timeline, seconds } = await recordLap('oval');
    const run = await testRun({ timeline });
    await runSeconds(run, seconds);
    const snapshot = run.snapshot();
    expect(snapshot.laps.count).toBe(1);
    expect(snapshot.laps.lapTimesUs).toHaveLength(1);
    expect(snapshot.collisions.count).toBe(0);
    await run.stop();
  }, 60_000);
});

describe('technical track', () => {
  it('can be lapped, too', async () => {
    const { timeline, seconds } = await recordLap('technical');
    const run = await testRun({ trackId: 'technical', timeline });
    await runSeconds(run, seconds);
    expect(run.snapshot().laps.count).toBe(1);
    expect(run.snapshot().collisions.count).toBe(0);
    await run.stop();
  }, 60_000);
});

describe('speed', () => {
  it('runs 60 s of sim time at 1 ms ticks in under 10 s of wall time', async () => {
    // Circles on open floor: the car is always moving, steering and in contact.
    const run = await testRun({
      noWalls: true,
      timeline: [
        ...drive(0.25),
        { tUs: ARMED_BY_US, gpio: STEERING_GPIO, pulseUs: steeringPulse(0.2) },
      ],
    });
    const started = performance.now();
    await runSeconds(run, 60);
    const wallS = (performance.now() - started) / 1000;
    expect(run.clock.nowUs).toBe(60_000_000);
    expect(wallS).toBeLessThan(10);
    await run.stop();
  }, 30_000);
});
