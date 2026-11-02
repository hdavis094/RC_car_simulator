import { describe, expect, it } from 'vitest';
import { createRngStreams } from './rng.ts';

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
