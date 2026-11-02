import { describe, expect, it } from 'vitest';
import type { TickInput } from '../api/actuator-source.ts';
import { ActuatorSourceEnded } from '../api/actuator-source.ts';
import { createScriptedSource } from './scripted-source.ts';

const tick = (n: number): TickInput => ({
  tick: n,
  t0Us: n * 1000,
  t1Us: (n + 1) * 1000,
  readings: [],
  gpioEdges: [],
  serialRx: new Uint8Array(0),
});

describe('scripted source', () => {
  it('emits each entry in the tick that contains its time, once', async () => {
    const source = createScriptedSource([
      { tUs: 2500, gpio: 25, pulseUs: 1700 },
      { tUs: 0, gpio: 26, pulseUs: 1500 },
      { tUs: 2999, gpio: 26, pulseUs: 1600, periodUs: 10_000 },
    ]);
    const out: unknown[][] = [];
    for (let n = 0; n < 5; n++) out.push((await source.step(tick(n))).pwm as unknown[]);
    expect(out[0]).toEqual([{ gpio: 26, periodUs: 20_000, pulseUs: 1500 }]);
    expect(out[1]).toEqual([]);
    expect(out[2]).toEqual([
      { gpio: 25, periodUs: 20_000, pulseUs: 1700 },
      { gpio: 26, periodUs: 10_000, pulseUs: 1600 },
    ]);
    expect(out[3]).toEqual([]);
    expect(out[4]).toEqual([]);
  });

  it('keeps same-time entries in file order', async () => {
    const source = createScriptedSource([
      { tUs: 0, gpio: 1, pulseUs: 1 },
      { tUs: 0, gpio: 2, pulseUs: 2 },
      { tUs: 0, gpio: 3, pulseUs: 3 },
    ]);
    expect((await source.step(tick(0))).pwm.map((p) => p.gpio)).toEqual([1, 2, 3]);
  });

  it('applies entries from before the first tick in it', async () => {
    const source = createScriptedSource([{ tUs: 0, gpio: 1, pulseUs: 1 }]);
    expect((await source.step(tick(7))).pwm).toHaveLength(1);
  });

  it('rejects bad entries when built', () => {
    expect(() => createScriptedSource([{ tUs: -1, gpio: 1, pulseUs: 1 }])).toThrow(
      /bad timeline entry/,
    );
    expect(() => createScriptedSource([{ tUs: 0, gpio: 1.5, pulseUs: 1 }])).toThrow(
      /bad timeline entry/,
    );
  });

  it('ends once stopped, and can be stopped twice', async () => {
    const source = createScriptedSource([]);
    await source.stop();
    await source.stop();
    await expect(source.step(tick(0))).rejects.toBeInstanceOf(ActuatorSourceEnded);
  });
});
