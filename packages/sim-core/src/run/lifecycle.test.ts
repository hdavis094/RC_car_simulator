import { describe, expect, it } from 'vitest';
import { ActuatorSourceEnded } from '../api/actuator-source.ts';
import type { ActuatorSource, ScriptedPwm } from '../api/actuator-source.ts';
import type { RunEnd } from '../api/run.ts';
import { createScriptedSource } from '../scenario/scripted-source.ts';
import {
  ARMED_BY_US,
  ESC_GPIO,
  NEUTRAL,
  runSeconds,
  testRun,
  throttlePulse,
} from './test-support.ts';

describe('Run lifecycle', () => {
  it('starts ready, runs, and counts ticks on the clock', async () => {
    const run = await testRun();
    expect(run.status).toBe('ready');
    expect(run.clock.nowUs).toBe(0);
    const result = await run.step(5);
    expect(result).toMatchObject({ ticks: 5, status: 'running', end: null });
    expect(run.clock.tick).toBe(5);
    expect(run.clock.nowUs).toBe(5000);
    expect(run.snapshot()).toMatchObject({ tick: 5, timeUs: 5000, status: 'running' });
    await run.stop();
  });

  it('uses the tick length it is given', async () => {
    const run = await testRun({ tickUs: 500 });
    await run.step(4);
    expect(run.clock.nowUs).toBe(2000);
    await run.stop();
  });

  it('ends once, with the first reason, and then runs no more ticks', async () => {
    const run = await testRun();
    const ends: RunEnd[] = [];
    run.on('end', (e) => ends.push(e));
    await run.step(3);
    await run.stop();
    await run.stop();
    expect(ends).toEqual([{ kind: 'stopped' }]);
    expect(run.status).toBe('ended');
    expect(await run.step(10)).toMatchObject({ ticks: 0, status: 'ended' });
    expect(run.clock.tick).toBe(3);
  });

  it('ends when the source ends, reporting why', async () => {
    const inner = createScriptedSource([]);
    let calls = 0;
    const source: ActuatorSource = {
      start: (s) => inner.start(s),
      stop: () => inner.stop(),
      async step(input) {
        if (++calls > 4) throw new ActuatorSourceEnded({ kind: 'finished' });
        return inner.step(input);
      },
    };
    const run = await testRun({ source });
    const result = await run.step(100);
    expect(result).toMatchObject({ ticks: 4, status: 'ended', end: { kind: 'finished' } });
    await run.stop();
    expect(run.end).toEqual({ kind: 'finished' });
  });

  it('ends with an error, rather than rejecting, when a tick fails', async () => {
    const source: ActuatorSource = {
      async start() {},
      async stop() {},
      async step() {
        throw new Error('boom');
      },
    };
    const run = await testRun({ source });
    expect(await run.step(5)).toMatchObject({ ticks: 0, end: { kind: 'error', message: 'boom' } });
  });

  it('refuses a second step while one is pending', async () => {
    const run = await testRun();
    const first = run.step(50);
    await expect(run.step(1)).rejects.toThrow(/pending/);
    await first;
    await run.stop();
  });

  it('cannot restart a scripted source', async () => {
    const run = await testRun();
    await expect(run.restartFirmware()).rejects.toThrow(/cannot restart/);
    await run.stop();
  });

  it('hands the source the device table of the wired parts, in car.json order', async () => {
    let devices: readonly string[] = [];
    const inner = createScriptedSource([]);
    const source: ActuatorSource = {
      ...inner,
      start: async (setup) => {
        devices = setup.devices.map((d) => `${d.instanceId}:${d.kind}`);
      },
      step: (input) => inner.step(input),
      stop: () => inner.stop(),
    };
    const run = await testRun({ source });
    expect(devices).toEqual(
      expect.arrayContaining(['esc:esc', 'steering:servo', 'tof_left:vl53l0x', 'imu:mpu6050']),
    );
    expect(devices.indexOf('esc:esc')).toBeLessThan(devices.indexOf('steering:servo'));
    await run.stop();
  });
});

describe('snapshot', () => {
  it('describes the car, obstacles, laps and collisions as plain data', async () => {
    const run = await testRun({
      obstacles: [{ id: 'c', type: 'cone', positionM: { x: 0, z: -4 }, yawDeg: 0 }],
      start: { x: 0, z: 0, yawDeg: 0 },
    });
    await run.step(200);
    const s = run.snapshot();
    expect(s.car.wheels).toHaveLength(4);
    expect(s.car.pose.rotation).toHaveLength(4);
    expect(s.obstacles.map((o) => o.id)).toEqual(['c']);
    expect(s.laps).toEqual({ count: 0, lapTimesUs: [] });
    expect(s.collisions).toEqual({ count: 0, last: null });
    // it survives IPC: structured cloning keeps it equal
    expect(structuredClone(s)).toEqual(s);
    await run.stop();
  });

  it('reports the command the car was given', async () => {
    const run = await testRun({
      timeline: [...NEUTRAL, { tUs: ARMED_BY_US, gpio: ESC_GPIO, pulseUs: throttlePulse(0.5) }],
    });
    await runSeconds(run, 4);
    expect(run.snapshot().car.command.motorDuty).toBeCloseTo(0.5, 2);
    expect(run.snapshot().car.forwardSpeedMps).toBeGreaterThan(0.5);
    await run.stop();
  });
});

describe('obstacle types', () => {
  const drive: ScriptedPwm[] = [
    ...NEUTRAL,
    { tUs: ARMED_BY_US, gpio: ESC_GPIO, pulseUs: throttlePulse(0.3) },
  ];

  it('stops the car at a box, with one collision', async () => {
    const run = await testRun({
      start: { x: 2.4, z: 0, yawDeg: 0 },
      obstacles: [{ id: 'b', type: 'box', positionM: { x: 2.4, z: -2 }, yawDeg: 0 }],
      timeline: drive,
    });
    await runSeconds(run, 9);
    expect(run.snapshot().collisions).toEqual({ count: 1, last: 'b' });
    expect(run.snapshot().car.pose.position[2]).toBeGreaterThan(-2); // did not go through
    await run.stop();
  });

  it('lets the car climb a ramp without a collision', async () => {
    const run = await testRun({
      start: { x: 2.4, z: 0, yawDeg: 0 },
      obstacles: [{ id: 'r', type: 'ramp', positionM: { x: 2.4, z: -1.5 }, yawDeg: 0 }],
      timeline: drive,
    });
    let peak = 0;
    for (let i = 0; i < 140; i++) {
      await runSeconds(run, 0.05);
      peak = Math.max(peak, run.snapshot().car.pose.position[1]);
    }
    expect(peak).toBeGreaterThan(0.03);
    expect(run.snapshot().car.pose.position[2]).toBeLessThan(-1.9); // over it and beyond
    await run.stop();
  });
});
