import { describe, expect, it } from 'vitest';
import { defaultCatalog, exampleCar, type World as WorldFile } from '@rcsim/schema';
import { createRun } from '../run/run.ts';
import { trackLibrary } from '../world/track-library.ts';
import { partContexts } from '../api/stubs/fake-run.ts';
import { createRngStreams } from '../clock/index.ts';
import { createImuSensorModel } from './imu.ts';

interface Reading {
  instanceId: string;
  accel: [number, number, number];
  gyro: [number, number, number];
}

interface TickInput {
  readings: Reading[];
}

interface TestSource {
  inputs: TickInput[];
  setup: unknown;
  start(s: unknown): Promise<void>;
  step(input: unknown): Promise<{
    pwm: unknown[];
    gpioWrites: unknown[];
    serialTx: Uint8Array;
    netEvents: unknown[];
    logs: unknown[];
  }>;
  stop(): Promise<void>;
}

function makeSource(): TestSource {
  const source: TestSource = {
    inputs: [],
    setup: undefined,
    async start(s: unknown) {
      this.setup = s;
    },
    async step(input: unknown) {
      this.inputs.push(input as TickInput);
      return { pwm: [], gpioWrites: [], serialTx: new Uint8Array(0), netEvents: [], logs: [] };
    },
    async stop() {},
  };
  return source;
}

describe('imu sensor', () => {
  it('at rest reads gravity on the up axis (Y) within bias + noise', async () => {
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
      source: source as never,
    });
    await run.step(50);
    const readings = source.inputs.flatMap((i) => i.readings).filter((r) => r.instanceId === 'imu');
    expect(readings.length).toBeGreaterThan(0);
    const r = readings[0] as { accel: [number, number, number] };
    expect(Math.abs(r.accel[1] - 9.81)).toBeLessThan(1.0);
    expect(Math.abs(r.accel[0])).toBeLessThan(1.0);
    expect(Math.abs(r.accel[2])).toBeLessThan(1.0);
    await run.stop();
  });

  it('spinning the vehicle in place shows the expected yaw rate (Y axis, right-handed)', () => {
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
    const readings = model.update(ctx as never);
    expect(readings.length).toBe(1);
    const r = readings[0] as unknown as { gyro: [number, number, number] };
    expect(r.gyro[1]).toBeGreaterThan(1.5);
    expect(r.gyro[1]).toBeLessThan(2.5);
  });
});
