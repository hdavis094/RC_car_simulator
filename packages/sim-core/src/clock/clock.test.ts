import { describe, expect, it } from 'vitest';
import { TickClock, createRngStreams } from './index.ts';

describe('TickClock', () => {
  it('counts whole ticks of integer microseconds', () => {
    const clock = new TickClock();
    expect(clock.tickUs).toBe(1000);
    expect([clock.tick, clock.nowUs]).toEqual([0, 0]);
    for (let i = 0; i < 3; i++) clock.advance();
    expect([clock.tick, clock.nowUs]).toEqual([3, 3000]);
  });

  it('takes another tick length', () => {
    const clock = new TickClock(250);
    clock.advance();
    expect(clock.nowUs).toBe(250);
  });

  it('rejects a tick that is not a positive whole number of microseconds', () => {
    for (const bad of [0, -1, 0.5, Number.NaN]) expect(() => new TickClock(bad)).toThrow(/tickUs/);
  });
});

describe('seeded streams', () => {
  it('give the same sequence for the same seed and name, and differ across names and seeds', () => {
    const draw = (seed: number, name: string): number[] => {
      const rng = createRngStreams(seed).stream(name);
      return [rng.next(), rng.next(), rng.int(100), rng.normal()];
    };
    expect(draw(5, 'sensor:a')).toEqual(draw(5, 'sensor:a'));
    expect(draw(5, 'sensor:a')).not.toEqual(draw(5, 'sensor:b'));
    expect(draw(5, 'sensor:a')).not.toEqual(draw(6, 'sensor:a'));
  });

  it("don't shift when another stream is used", () => {
    const a = createRngStreams(9);
    const first = a.stream('x').next();
    const b = createRngStreams(9);
    b.stream('other').next();
    b.stream('other').next();
    expect(b.stream('x').next()).toBe(first);
  });
});
