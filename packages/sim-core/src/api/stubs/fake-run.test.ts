import { defaultCatalog, exampleCar, type Track, type World as WorldFile } from '@rcsim/schema';
import { describe, expect, it } from 'vitest';
import type { GpioEdge } from '@rcsim/sim-protocol';
import {
  ActuatorSourceEnded,
  parseAssertion,
  type Run,
  type SensorModel,
  type TickInput,
} from '../index.ts';
import {
  FakeActuatorSource,
  FakeVehicle,
  createFakeRun,
  createFakeSensorModel,
  createRngStreams,
} from './index.ts';

const track: Track = {
  schemaVersion: 1,
  id: 'test-loop',
  name: 'Test loop',
  centreline: {
    kind: 'polyline',
    pointsM: [
      { x: 0, z: 0 },
      { x: 0, z: -10 },
      { x: 5, z: -10 },
      { x: 5, z: 0 },
    ],
  },
  widthM: 1.2,
  wallHeightM: 0.2,
  startFinish: { point: 0 },
  start: { positionM: { x: 0, z: 0 }, yawDeg: 0 },
};

const world = (obstacles: WorldFile['obstacles'] = []): WorldFile => ({
  schemaVersion: 1,
  name: 'test',
  trackId: 'test-loop',
  seed: 1,
  obstacles,
});

const ESC_GPIO = 26;
const STEERING_GPIO = 25;

async function fakeRun(
  source: FakeActuatorSource,
  obstacles: WorldFile['obstacles'] = [],
): Promise<Run> {
  return createFakeRun({
    car: exampleCar,
    catalog: defaultCatalog,
    world: world(obstacles),
    track,
    seed: 7,
    source,
  });
}

describe('a Run assembled from the stubs alone', () => {
  it('steps, drives forward on full throttle and reports it in the snapshot', async () => {
    const source = new FakeActuatorSource([
      { tUs: 0, gpio: ESC_GPIO, pulseUs: 2000 },
      { tUs: 0, gpio: STEERING_GPIO, pulseUs: 2000 },
    ]);
    const run = await fakeRun(source);
    expect(run.status).toBe('ready');

    const result = await run.step(100);
    expect(result).toEqual({ ticks: 100, status: 'running', end: null });

    const snapshot = run.snapshot();
    expect(snapshot.tick).toBe(100);
    expect(snapshot.timeUs).toBe(100_000);
    expect(snapshot.car.command.motorDuty).toBe(1);
    // Pulses above neutral steer right with the default (positive) linkage ratio.
    expect(snapshot.car.command.steerAngleRad).toBeLessThan(0);
    expect(snapshot.car.pose.position[2]).toBeLessThan(-0.25); // forward is −Z
    expect(snapshot.car.wheels).toHaveLength(4);
    expect(structuredClone(snapshot)).toEqual(snapshot);
  });

  it('hands the source a device table and the previous tick’s readings', async () => {
    const source = new FakeActuatorSource();
    const run = await fakeRun(source);
    await run.step(40);
    expect(source.setup?.devices.map((d) => [d.instanceId, d.kind])).toEqual([
      ['esc', 'esc'],
      ['steering', 'servo'],
      ['tof_left', 'vl53l0x'],
      ['tof_centre', 'vl53l0x'],
      ['tof_right', 'vl53l0x'],
      ['imu', 'mpu6050'],
      ['battery_sense', 'analog'],
    ]);
    const first = source.inputs[0];
    expect(first?.readings).toEqual([]);
    // The ToF reads at 30 Hz, so only some ticks carry its readings.
    const tofReadings = source.inputs
      .flatMap((i) => i.readings)
      .filter((r) => r.instanceId === 'tof_left');
    expect(tofReadings.length).toBeGreaterThanOrEqual(1);
    expect(tofReadings.every((r) => r.type === 'distance')).toBe(true);
    for (const input of source.inputs.slice(1)) {
      for (const reading of input.readings) {
        expect(reading.tUs).toBeLessThan(input.t0Us);
        expect(reading.tUs).toBeGreaterThanOrEqual(input.t0Us - 1000);
      }
    }
  });

  it('counts a collision with a cone in its path', async () => {
    const source = new FakeActuatorSource([{ tUs: 0, gpio: ESC_GPIO, pulseUs: 2000 }]);
    const run = await fakeRun(source, [
      { id: 'cone-1', type: 'cone', positionM: { x: 0, z: -1 }, yawDeg: 0 },
    ]);
    await run.step(500);
    expect(run.snapshot().collisions).toEqual({ count: 1, last: 'cone-1' });
  });

  it('ends when the source ends, and stop() is safe afterwards', async () => {
    const source = new FakeActuatorSource([], { endUs: 5000 });
    const run = await fakeRun(source);
    const ends: unknown[] = [];
    run.on('end', (end) => ends.push(end));
    const result = await run.step(100);
    expect(result.ticks).toBe(5);
    expect(result.end).toEqual({ kind: 'finished' });
    expect(ends).toEqual([{ kind: 'finished' }]);
    await run.stop();
    expect(run.status).toBe('ended');
  });

  it('edits obstacles between steps and saves the layout', async () => {
    const run = await fakeRun(new FakeActuatorSource());
    const id = run.world.addObstacle({ type: 'box', positionM: { x: 1, z: -2 }, yawDeg: 90 });
    run.world.moveObstacle(id, { x: 2, z: -3 }, 45);
    const saved = run.world.toWorldFile();
    expect(saved.obstacles).toHaveLength(1);
    expect(saved.obstacles[0]).toMatchObject({ id, type: 'box', positionM: { x: 2, z: -3 } });
    expect(saved.obstacles[0]?.yawDeg).toBeCloseTo(45, 9);
  });

  it('exposes ActuatorSourceEnded for sources to throw', () => {
    expect(new ActuatorSourceEnded({ kind: 'stalled', afterMs: 2000 }).end.kind).toBe('stalled');
  });
});

describe('the reference loop', () => {
  it('merges GPIO edges from all sensors in ascending time', async () => {
    const source = new FakeActuatorSource();
    const edgesFor = (instanceId: string): GpioEdge[] =>
      instanceId === 'tof_left'
        ? [{ gpio: 16, tUs: 900, level: true }]
        : instanceId === 'tof_right'
          ? [{ gpio: 18, tUs: 100, level: true }]
          : [];
    const run = await createFakeRun({
      car: exampleCar,
      catalog: defaultCatalog,
      world: world(),
      track,
      seed: 1,
      source,
      createSensorModel: (part): SensorModel => {
        const base = createFakeSensorModel(part);
        let given = false;
        return {
          ...base,
          update: base.update,
          beams: base.beams,
          takeGpioEdges: () => {
            if (given) return [];
            given = true;
            return edgesFor(part.instance.instanceId);
          },
        };
      },
    });
    await run.step(1);
    expect(source.inputs[0]?.gpioEdges.map((e) => e.tUs)).toEqual([100, 900]);
  });

  it('keeps serial queued while the source is busy for the next tick', async () => {
    let release: (() => void) | undefined;
    const source = new FakeActuatorSource();
    const step = source.step.bind(source);
    let first = true;
    source.step = async (input: TickInput) => {
      if (first) {
        first = false;
        await new Promise<void>((resolve) => (release = resolve));
      }
      return step(input);
    };
    const run = await fakeRun(source);
    const stepping = run.step(2);
    await new Promise((resolve) => setTimeout(resolve, 0));
    run.sendSerial(new TextEncoder().encode('hi'));
    release?.();
    await stepping;
    expect(new TextDecoder().decode(source.inputs[1]?.serialRx)).toBe('hi');
  });
});

describe('FakeVehicle.chassisToWorld', () => {
  it('rotates the offset with the car and composes yaw and pitch', () => {
    const car = new FakeVehicle({ x: 0, z: 0, yawDeg: 90 });
    const pose = car.chassisToWorld({ x: 0, y: 0, z: -1000 }, 0, 0);
    // Facing +90° (left of −Z is −X), a point 1 m ahead is at x = −1.
    expect(pose.position[0]).toBeCloseTo(-1, 9);
    expect(pose.position[2]).toBeCloseTo(0, 9);
    const pitched = car.chassisToWorld({ x: 0, y: 0, z: 0 }, 0, 90).rotation;
    expect(Math.hypot(...pitched)).toBeCloseTo(1, 9);
    expect(pitched[0]).not.toBe(0);
  });
});

describe('parseAssertion', () => {
  it("accepts the brief's short names", () => {
    expect(parseAssertion('maxSpeed < 3')).toEqual({ metric: 'maxSpeedMps', op: '<', value: 3 });
    expect(parseAssertion('laps >= 1')).toEqual({ metric: 'laps', op: '>=', value: 1 });
    expect(() => parseAssertion('speed > 1')).toThrow(/bad assertion/);
  });
});

describe('createRngStreams', () => {
  it('gives each name its own sequence, independent of other streams', () => {
    const a = createRngStreams(1);
    const tof = Array.from({ length: 5 }, () => a.stream('sensor:tof_left').next());
    const b = createRngStreams(1);
    b.stream('sensor:new_part').next(); // adding a sensor…
    const again = Array.from({ length: 5 }, () => b.stream('sensor:tof_left').next());
    expect(again).toEqual(tof); // …leaves the others unchanged
    expect(createRngStreams(2).stream('sensor:tof_left').next()).not.toBe(tof[0]);
  });

  it('draws normals with mean about 0 and σ about 1', () => {
    const rng = createRngStreams(3).stream('x');
    const draws = Array.from({ length: 20_000 }, () => rng.normal());
    const mean = draws.reduce((s, v) => s + v, 0) / draws.length;
    const sd = Math.sqrt(draws.reduce((s, v) => s + (v - mean) ** 2, 0) / draws.length);
    expect(Math.abs(mean)).toBeLessThan(0.03);
    expect(Math.abs(sd - 1)).toBeLessThan(0.03);
  });
});
