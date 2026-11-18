import { describe, expect, it } from 'vitest';
import { defaultCatalog, exampleCar, type World as WorldFile } from '@rcsim/schema';
import { createRun } from '../run/run.ts';
import { trackLibrary } from '../world/track-library.ts';

interface Reading {
  instanceId: string;
  volts: number;
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

describe('voltage divider', () => {
  it('pack voltage through the divider into an ADC reading', async () => {
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
        obstacles: [],
        start: { positionM: { x: 0, z: 0 }, yawDeg: 0 },
      } as WorldFile,
      track,
      seed: 1,
      source: source as never,
    });
    await run.step(100);
    const readings = source.inputs
      .flatMap((i) => i.readings)
      .filter((r) => r.instanceId === 'battery_sense');
    expect(readings.length).toBeGreaterThan(0);
    const expected = (2 * 3.7 * 33000) / (100000 + 33000);
    const r = readings[0] as unknown as { volts: number };
    expect(Math.abs(r.volts - expected)).toBeLessThan(0.01);
    await run.stop();
  });
});
