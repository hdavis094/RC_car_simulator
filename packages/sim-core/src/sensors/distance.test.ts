import { describe, expect, it } from 'vitest';
import { defaultCatalog, exampleCar, type World as WorldFile } from '@rcsim/schema';
import { createRun } from '../run/run.ts';
import { trackLibrary } from '../world/track-library.ts';
import { makeSource } from './test-helpers.ts';

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
        seed: 2,
        obstacles: [{ id: 'w', type: 'box', positionM: { x: 0, z: -0.92 }, yawDeg: 0 }],
        start: { positionM: { x: 0, z: 0 }, yawDeg: 0 },
      } as WorldFile,
      track,
      seed: 2,
      source,
    });
    await run.step(1000);
    const readings = source.inputs
      .flatMap((i) => i.readings)
      .filter((r) => r.instanceId === 'tof_centre') as {
      instanceId: string;
      mm: number;
      status: string;
    }[];
    // Configured rate 30 Hz => exactly 30 readings over 1 s.
    expect(readings.length).toBe(30);
    const sigma = 0.04 * 500; // 4 % of 500 mm
    const limit = 3 * sigma;
    for (const r of readings) {
      expect(Math.abs(r.mm - 500)).toBeLessThanOrEqual(limit);
    }
    const mean = readings.reduce((a, r) => a + r.mm, 0) / readings.length;
    expect(Math.abs(mean - 500)).toBeLessThan(10);
    const variance = readings.reduce((a, r) => a + (r.mm - mean) ** 2, 0) / (readings.length - 1);
    const sampleStd = Math.sqrt(variance);
    expect(sampleStd).toBeGreaterThan(sigma * 0.8);
    expect(sampleStd).toBeLessThan(sigma * 1.2);
    await run.stop();
  });

  it('a wall just past max range gives out-of-range readings', async () => {
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
        obstacles: [{ id: 'w', type: 'box', positionM: { x: 0, z: -1.67 }, yawDeg: 0 }],
        start: { positionM: { x: 0, z: 0 }, yawDeg: 0 },
      } as WorldFile,
      track,
      seed: 1,
      source,
    });
    await run.step(200);
    const readings = source.inputs
      .flatMap((i) => i.readings)
      .filter((r) => r.instanceId === 'tof_centre') as {
      instanceId: string;
      mm: number;
      status: string;
    }[];
    expect(readings.length).toBeGreaterThan(0);
    for (const r of readings) {
      expect(r.status).toBe('no-target');
      expect(r.mm).toBe(8190);
    }
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
    const source = makeSource();
    const origStep = source.step.bind(source);
    source.step = async (input: unknown) => {
      const writes: { gpio: number; tUs: number; level: boolean }[] = [];
      if (!triggered && (input as { t0Us: number }).t0Us === 0) {
        triggered = true;
        writes.push({ gpio: 13, tUs: 0, level: true });
        writes.push({ gpio: 13, tUs: 10, level: false });
      }
      const out = await origStep(input as unknown as Parameters<typeof origStep>[0]);
      (
        out as unknown as { gpioWrites: { gpio: number; tUs: number; level: boolean }[] }
      ).gpioWrites = writes;
      return out as unknown as Awaited<ReturnType<typeof source.step>>;
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
      source,
    });
    await run.step(50);
    const edges = source.inputs.flatMap((i) => i.gpioEdges).filter((e) => e.gpio === 34);
    const rise = edges.find((e) => e.level === true);
    const fall = edges.find((e) => e.level === false);
    expect(rise).toBeDefined();
    expect(fall).toBeDefined();
    const width = (fall as { tUs: number }).tUs - (rise as { tUs: number }).tUs;
    expect(Math.abs(width - 5831)).toBeLessThan(5831 * 0.01);
    await run.stop();
  });

  it('HC-SR04 rejects a TRIG pulse under 10 µs', async () => {
    const car = structuredClone(exampleCar);
    car.parts.push({
      instanceId: 'sonar',
      partId: 'sensor.hc-sr04',
      placement: { mount: 'front-centre' },
      pins: { VCC: { part: 'regulator', pin: 'VOUT' }, TRIG: { gpio: 13 }, ECHO: { gpio: 34 } },
    } as (typeof exampleCar.parts)[number]);
    const track = trackLibrary.load('oval');
    let triggered = false;
    const source = makeSource();
    const origStep = source.step.bind(source);
    source.step = async (input: unknown) => {
      const writes: { gpio: number; tUs: number; level: boolean }[] = [];
      if (!triggered && (input as { t0Us: number }).t0Us === 0) {
        triggered = true;
        writes.push({ gpio: 13, tUs: 0, level: true });
        writes.push({ gpio: 13, tUs: 5, level: false });
      }
      const out = await origStep(input as unknown as Parameters<typeof origStep>[0]);
      (
        out as unknown as { gpioWrites: { gpio: number; tUs: number; level: boolean }[] }
      ).gpioWrites = writes;
      return out as unknown as Awaited<ReturnType<typeof source.step>>;
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
      source,
    });
    await run.step(50);
    const edges = source.inputs.flatMap((i) => i.gpioEdges).filter((e) => e.gpio === 34);
    expect(edges.length).toBe(0);
    await run.stop();
  });

  it('HC-SR04 TRIG straddling a tick boundary still delivers the echo', async () => {
    const car = structuredClone(exampleCar);
    car.parts.push({
      instanceId: 'sonar',
      partId: 'sensor.hc-sr04',
      placement: { mount: 'front-centre' },
      pins: { VCC: { part: 'regulator', pin: 'VOUT' }, TRIG: { gpio: 13 }, ECHO: { gpio: 34 } },
    } as (typeof exampleCar.parts)[number]);
    const track = trackLibrary.load('oval');
    let triggered = false;
    const source = makeSource();
    const origStep = source.step.bind(source);
    source.step = async (input: unknown) => {
      const writes: { gpio: number; tUs: number; level: boolean }[] = [];
      if (!triggered && (input as { t0Us: number }).t0Us === 0) {
        triggered = true;
        writes.push({ gpio: 13, tUs: 990, level: true });
      }
      if (triggered && (input as { t0Us: number }).t0Us === 1000) {
        writes.push({ gpio: 13, tUs: 1005, level: false });
      }
      const out = await origStep(input as unknown as Parameters<typeof origStep>[0]);
      (
        out as unknown as { gpioWrites: { gpio: number; tUs: number; level: boolean }[] }
      ).gpioWrites = writes;
      return out as unknown as Awaited<ReturnType<typeof source.step>>;
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
      source,
    });
    await run.step(100);
    const edges = source.inputs.flatMap((i) => i.gpioEdges).filter((e) => e.gpio === 34);
    const rise = edges.find((e) => e.level === true);
    const fall = edges.find((e) => e.level === false);
    expect(rise).toBeDefined();
    expect(fall).toBeDefined();
    await run.stop();
  });

  it('HC-SR04 with no target emits a ~38 ms timeout pulse', async () => {
    const car = structuredClone(exampleCar);
    car.parts.push({
      instanceId: 'sonar',
      partId: 'sensor.hc-sr04',
      placement: { mount: 'front-centre' },
      pins: { VCC: { part: 'regulator', pin: 'VOUT' }, TRIG: { gpio: 13 }, ECHO: { gpio: 34 } },
    } as (typeof exampleCar.parts)[number]);
    const track = { ...trackLibrary.load('oval'), wallHeightM: 0 };
    let triggered = false;
    const source = makeSource();
    const origStep = source.step.bind(source);
    source.step = async (input: unknown) => {
      const writes: { gpio: number; tUs: number; level: boolean }[] = [];
      if (!triggered && (input as { t0Us: number }).t0Us === 0) {
        triggered = true;
        writes.push({ gpio: 13, tUs: 0, level: true });
        writes.push({ gpio: 13, tUs: 10, level: false });
      }
      const out = await origStep(input as unknown as Parameters<typeof origStep>[0]);
      (
        out as unknown as { gpioWrites: { gpio: number; tUs: number; level: boolean }[] }
      ).gpioWrites = writes;
      return out as unknown as Awaited<ReturnType<typeof source.step>>;
    };
    const run = await createRun({
      car,
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
      source,
    });
    await run.step(100);
    const edges = source.inputs.flatMap((i) => i.gpioEdges).filter((e) => e.gpio === 34);
    const rise = edges.find((e) => e.level === true);
    const fall = edges.find((e) => e.level === false);
    expect(rise).toBeDefined();
    expect(fall).toBeDefined();
    const width = (fall as { tUs: number }).tUs - (rise as { tUs: number }).tUs;
    expect(width).toBeGreaterThan(37_000);
    expect(width).toBeLessThan(39_000);
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
      source,
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
      .filter((r) => r.instanceId === 'tof_centre') as {
      instanceId: string;
      mm: number;
      status: string;
    }[];
    const modReadings = mod.inputs
      .flatMap((i) => i.readings)
      .filter((r) => r.instanceId === 'tof_centre') as {
      instanceId: string;
      mm: number;
      status: string;
    }[];
    const extraReadings = mod.inputs
      .flatMap((i) => i.readings)
      .filter((r) => r.instanceId === 'tof_extra');
    expect(modReadings).toEqual(baseReadings);
    expect(extraReadings.length).toBeGreaterThan(0);
  });
});
