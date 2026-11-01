import { describe, expect, it } from 'vitest';
import { Car } from './car.ts';
import { exampleCar } from './example-car.ts';
import { Track } from './track.ts';
import { World } from './world.ts';

describe('Car', () => {
  it('parses the example car', () => {
    expect(exampleCar.parts.length).toBeGreaterThan(5);
  });

  it('rejects an instance id used twice', () => {
    const car = structuredClone(exampleCar);
    car.parts.push({ ...car.parts[0]! });
    expect(Car.safeParse(car).success).toBe(false);
  });

  it('rejects instance ids that are not lowercase C identifiers', () => {
    for (const instanceId of [
      'TofLeft',
      'tof-left',
      '1tof',
      'tof left',
      'tof__left',
      'steering_',
    ]) {
      const car = structuredClone(exampleCar);
      car.parts[0] = { ...car.parts[0]!, instanceId };
      expect(Car.safeParse(car).success, instanceId).toBe(false);
    }
  });
});

const world = {
  schemaVersion: 1,
  name: 'Cones on the oval',
  trackId: 'oval',
  seed: 1,
  obstacles: [
    { id: 'c1', type: 'cone', positionM: { x: 1, z: -2 }, yawDeg: 0 },
    { id: 'c2', type: 'box', positionM: { x: -1, z: -4 }, yawDeg: 45 },
  ],
};

describe('World', () => {
  it('parses a world', () => {
    expect(World.parse(world).obstacles).toHaveLength(2);
  });

  it('rejects duplicate obstacle ids', () => {
    const dup = { ...world, obstacles: [world.obstacles[0], world.obstacles[0]] };
    expect(World.safeParse(dup).success).toBe(false);
  });

  it('rejects a seed outside uint32', () => {
    expect(World.safeParse({ ...world, seed: 2 ** 32 }).success).toBe(false);
  });
});

describe('Track', () => {
  const track = {
    schemaVersion: 1,
    id: 'square',
    name: 'Square',
    centreline: {
      kind: 'polyline',
      pointsM: [
        { x: 0, z: 0 },
        { x: 0, z: -10 },
        { x: 10, z: -10 },
        { x: 10, z: 0 },
      ],
    },
    widthM: 1.5,
    wallHeightM: 0.2,
    startFinish: { point: 0 },
    start: { positionM: { x: 0, z: 0.5 }, yawDeg: 0 },
  };

  it('parses a track', () => {
    expect(Track.parse(track).centreline.pointsM).toHaveLength(4);
  });

  it('rejects a start/finish line past the last point', () => {
    expect(Track.safeParse({ ...track, startFinish: { point: 4 } }).success).toBe(false);
  });
});
