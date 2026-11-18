import { describe, expect, it } from 'vitest';
import { defaultCatalog, exampleCar, type World as WorldFile } from '@rcsim/schema';
import { createRun } from '../run/run.ts';
import { trackLibrary } from '../world/track-library.ts';
import { partContexts } from '../api/stubs/fake-run.ts';
import { createRngStreams } from '../clock/index.ts';
import { createImuSensorModel } from './imu.ts';
import { makeSource } from './test-helpers.ts';

interface Reading {
  instanceId: string;
  accel: [number, number, number];
  gyro: [number, number, number];
}

interface TickInput {
  readings: Reading[];
}

describe('imu sensor', () => {
  it('at rest reads gravity on chip Z within bias + noise', async () => {
    const track = trackLibrary.load('oval');
    const source = makeSource();
    const run = await createRun({
      car: exampleCar,
      catalog: defaultCatalog,
      world: {
        schemaVersion: 1,
        name: 't',
        trackId: 'oval',
        seed: 2,
        obstacles: [],
        start: { positionM: { x: 0, z: 0 }, yawDeg: 0 },
      } as WorldFile,
      track,
      seed: 2,
      source,
    });
    await run.step(50);
    const readings = (source.inputs as unknown as TickInput[])
      .flatMap((i) => i.readings)
      .filter((r) => r.instanceId === 'imu') as {
      instanceId: string;
      accel: [number, number, number];
      gyro: [number, number, number];
    }[];
    expect(readings.length).toBeGreaterThan(0);
    const r = readings[0]! as unknown as { accel: [number, number, number] };
    expect(Math.abs(r.accel[2] - 9.81)).toBeLessThan(1.0);
    expect(Math.abs(r.accel[0])).toBeLessThan(1.0);
    expect(Math.abs(r.accel[1])).toBeLessThan(1.0);
    await run.stop();
  });

  it('spinning the vehicle shows the expected yaw rate on chip gyro Z (CCW positive)', () => {
    const rng = createRngStreams(3);
    const contexts = partContexts({ car: exampleCar, catalog: defaultCatalog }, rng);
    const imuPart = contexts.find((p) => p.instance.instanceId === 'imu')!;
    const model = createImuSensorModel(imuPart);
    const vehicleState = {
      pose: { position: [0, 0, 0], rotation: [0, 0, 0, 1] },
      velocity: [0, 0, 0],
      angularVelocity: [0, 2.0, 0],
      forwardSpeedMps: 0,
      acceleration: [0, 0, 0],
      command: { steerAngleRad: 0, motorDuty: 0 },
      wheels: [],
    };
    const ctx = {
      nowUs: 1000,
      dtUs: 1000,
      world: {},
      vehicle: vehicleState,
      rng: rng.stream('sensor:imu'),
    };
    const readings = model.update(ctx as unknown as Parameters<typeof model.update>[0]);
    expect(readings.length).toBe(1);
    const r = readings[0]! as unknown as { gyro: [number, number, number] };
    expect(r.gyro[2]).toBeGreaterThan(1.5);
    expect(r.gyro[2]).toBeLessThan(2.5);
  });

  it('rotated placement (yaw 90°) still reports yaw on chip gyro Z', () => {
    const car = structuredClone(exampleCar);
    const imu = car.parts.find((p) => p.instanceId === 'imu')!;
    imu.placement = { mount: 'roof', yawDeg: 90 };
    const rng = createRngStreams(5);
    const contexts = partContexts({ car, catalog: defaultCatalog }, rng);
    const imuPart = contexts.find((p) => p.instance.instanceId === 'imu')!;
    const model = createImuSensorModel(imuPart);
    const vehicleState = {
      pose: { position: [0, 0, 0], rotation: [0, 0, 0, 1] },
      velocity: [0, 0, 0],
      angularVelocity: [0, 2.0, 0],
      forwardSpeedMps: 0,
      acceleration: [0, 0, 0],
      command: { steerAngleRad: 0, motorDuty: 0 },
      wheels: [],
    };
    const ctx = {
      nowUs: 1000,
      dtUs: 1000,
      world: {},
      vehicle: vehicleState,
      rng: rng.stream('sensor:imu'),
    };
    const readings = model.update(ctx as unknown as Parameters<typeof model.update>[0]);
    const r = readings[0]! as unknown as { gyro: [number, number, number] };
    expect(Math.abs(r.gyro[2])).toBeGreaterThan(1.5);
  });
});
