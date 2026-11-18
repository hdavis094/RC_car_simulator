import { describe, expect, it } from 'vitest';
import { defaultCatalog, exampleCar, type World as WorldFile } from '@rcsim/schema';
import { createRun } from '../run/run.ts';
import { trackLibrary } from '../world/track-library.ts';

interface Reading {
  instanceId: string;
  mm: number;
  status: string;
}

interface TickInput {
  readings: Reading[];
  gpioEdges: { gpio: number; tUs: number; level: boolean }[];
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

describe('distance sensors', () => {
  it('a ToF sensor facing a wall 500 mm away reads 500 ± 3σ mm over 1 s', async () => {
    const track = trackLibrary.load('oval');
    const source = makeSource();
    const run = await createRun({
      car: exampleCar,
      catalog: defaultCatalog,
      world: {
        schemaVersion: 1,
        name: 't',
        trackId: 'oval',
        seed: 1,
        obstacles: [{ id: 'w', type: 'box', positionM: { x: 0, z: -0.92 }, yawDeg: 0 }],
        start: { positionM: { x: 0, z: 0 }, yawDeg: 0 },
      } as WorldFile,
      track,
      seed: 1,
      source: source as never,
    });
    await run.step(1000);
    const readings = source.inputs
      .flatMap((i) => i.readings)
      .filter((r) => r.instanceId === 'tof_centre');
    expect(readings.length).toBeGreaterThan(20);
    const mean = readings.reduce((a, r) => a + r.mm, 0) / readings.length;
    expect(Math.abs(mean - 500)).toBeLessThan(15);
    await run.stop();
  });

  it('a wall beyond max range gives out-of-range readings', async () => {
    const track = { ...trackLibrary.load('oval'), wallHeightM: 0 };
    const source = makeSource();
    const run = await createRun({
      car: exampleCar,
      catalog: defaultCatalog,
      world: {
        schemaVersion: 1,
        name: 't',
        trackId: 'oval',
        seed: 1,
        obstacles: [],
        start: { positionM: { x: 0, z: 0 }, yawDeg: 0 },
      } as WorldFile,
      track,
      seed: 1,
      source: source as never,
    });
    await run.step(200);
    const readings = source.inputs
      .flatMap((i) => i.readings)
      .filter((r) => r.instanceId === 'tof_centre');
    expect(readings.length).toBeGreaterThan(0);
    expect(readings.every((r) => r.status === 'no-target')).toBe(true);
    await run.stop();
  });

  it('an HC-SR04 echo high time for 1 m is 5 831 µs ± 1 %', async () => {
    const car = structuredClone(exampleCar);
    car.parts.push({
      instanceId: 'sonar',
      partId: 'sensor.hc-sr04',
      placement: { mount: 'front-centre' },
      pins: { VCC: { part: 'regulator', pin: 'VOUT' }, TRIG: { gpio: 13 }, ECHO: { gpio: 34 } },
    } as (typeof exampleCar.parts)[number]);
    const track = trackLibrary.load('oval');
    let triggered = false;
    const source: TestSource = {
      inputs: [],
      setup: undefined,
      async start(s: unknown) {
        this.setup = s;
      },
      async step(input: unknown) {
        this.inputs.push(input as TickInput);
        const writes: { gpio: number; tUs: number; level: boolean }[] = [];
        if (!triggered && (input as { t0Us: number }).t0Us === 0) {
          triggered = true;
          writes.push({ gpio: 13, tUs: 0, level: true });
          writes.push({ gpio: 13, tUs: 10, level: false });
        }
        return {
          pwm: [],
          gpioWrites: writes,
          serialTx: new Uint8Array(0),
          netEvents: [],
          logs: [],
        };
      },
      async stop() {},
    };
    const run = await createRun({
      car,
      catalog: defaultCatalog,
      world: {
        schemaVersion: 1,
        name: 't',
        trackId: 'oval',
        seed: 1,
        obstacles: [{ id: 'w', type: 'box', positionM: { x: 0, z: -1.42 }, yawDeg: 0 }],
        start: { positionM: { x: 0, z: 0 }, yawDeg: 0 },
      } as WorldFile,
      track,
      seed: 1,
      source: source as never,
    });
    await run.step(50);
    const edges = source.inputs.flatMap((i) => i.gpioEdges).filter((e) => e.gpio === 34);
    const rise = edges.find((e) => e.level === true);
    const fall = edges.find((e) => e.level === false);
    expect(rise).toBeDefined();
    expect(fall).toBeDefined();
    const width =
      (fall as unknown as { tUs: number }).tUs - (rise as unknown as { tUs: number }).tUs;
    expect(Math.abs(width - 5831)).toBeLessThan(5831 * 0.01);
    await run.stop();
  });

  async function runWithCar(car: typeof exampleCar, ticks = 100) {
    const track = trackLibrary.load('oval');
    const source = makeSource();
    const run = await createRun({
      car,
      catalog: defaultCatalog,
      world: {
        schemaVersion: 1,
        name: 't',
        trackId: 'oval',
        seed: 7,
        obstacles: [{ id: 'w', type: 'box', positionM: { x: 0, z: -0.92 }, yawDeg: 0 }],
        start: { positionM: { x: 0, z: 0 }, yawDeg: 0 },
      } as WorldFile,
      track,
      seed: 7,
      source: source as never,
    });
    await run.step(ticks);
    await run.stop();
    return source;
  }

  it('adding a sensor leaves an existing sensor reading sequence unchanged', async () => {
    const base = await runWithCar(exampleCar, 100);
    const car2 = structuredClone(exampleCar);
    car2.parts.push({
      instanceId: 'tof_extra',
      partId: 'sensor.vl53l0x-pololu',
      placement: { mount: 'front-left' },
      pins: {
        VIN: { part: 'esp32', pin: '3V3' },
        SDA: { gpio: 21 },
        SCL: { gpio: 22 },
        XSHUT: { gpio: 19 },
      },
    } as (typeof exampleCar.parts)[number]);
    const mod = await runWithCar(car2, 100);
    const baseReadings = base.inputs
      .flatMap((i) => i.readings)
      .filter((r) => r.instanceId === 'tof_centre');
    const modReadings = mod.inputs
      .flatMap((i) => i.readings)
      .filter((r) => r.instanceId === 'tof_centre');
    expect(modReadings).toEqual(baseReadings);
  });
});
