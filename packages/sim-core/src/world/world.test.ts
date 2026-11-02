import { defaultCatalog, exampleCar, type Obstacle } from '@rcsim/schema';
import { describe, expect, it } from 'vitest';
import { testWorldFile } from '../run/test-support.ts';
import { createWorld } from './world.ts';
import { trackLibrary } from './track-library.ts';

/** Rapier's spatial index is current only after a step (see PhysicsWorld). */
const settle = (world: { step(dtS: number, nowUs: number): unknown }): void => {
  world.step(0.001, 0);
};

const cone = (id: string, x: number, z: number): Obstacle => ({
  id,
  type: 'cone',
  positionM: { x, z },
  yawDeg: 0,
});

describe('raycasts', () => {
  it('hit the ground', async () => {
    const world = await createWorld(testWorldFile(), trackLibrary.load('oval'));
    settle(world);
    const hit = world.raycast([0, 0.5, 0], [0, -1, 0], 2);
    expect(hit?.target).toEqual({ kind: 'ground' });
    expect(hit?.distanceM).toBeCloseTo(0.5, 3);
    expect(hit?.normal[1]).toBeCloseTo(1, 3);
  });

  it('return null beyond the range', async () => {
    const world = await createWorld(testWorldFile(), trackLibrary.load('oval'));
    settle(world);
    expect(world.raycast([0, 0.5, 0], [0, -1, 0], 0.3)).toBeNull();
    expect(world.raycast([0, 0.5, 0], [0, 1, 0], 50)).toBeNull();
  });

  it('hit an obstacle by id, nearest first', async () => {
    const world = await createWorld(
      testWorldFile({ obstacles: [cone('near', 2.4, -1), cone('far', 2.4, -2)] }),
      trackLibrary.load('oval'),
    );
    settle(world);
    const hit = world.raycast([2.4, 0.1, 0], [0, 0, -1], 5);
    expect(hit?.target).toEqual({ kind: 'obstacle', id: 'near' });
    // the cone's base radius is 0.06 m, a little less at 0.1 m height
    expect(hit?.distanceM).toBeGreaterThan(0.95);
    expect(hit?.distanceM).toBeLessThan(0.97);
  });

  it('hit the track walls at the lane edge', async () => {
    const track = trackLibrary.load('oval');
    const world = await createWorld(testWorldFile(), track);
    settle(world);
    // From the centreline on the right-hand straight, outward (+X) and inward (−X)
    const outward = world.raycast([2.4, 0.05, 0], [1, 0, 0], 3);
    expect(outward?.target).toEqual({ kind: 'wall' });
    expect(outward?.distanceM).toBeCloseTo(track.widthM / 2, 2);
    const inward = world.raycast([2.4, 0.05, 0], [-1, 0, 0], 3);
    expect(inward?.target).toEqual({ kind: 'wall' });
    expect(inward?.distanceM).toBeCloseTo(track.widthM / 2, 2);
  });

  it('pass over a track with no walls', async () => {
    const track = { ...trackLibrary.load('oval'), wallHeightM: 0 };
    const world = await createWorld(testWorldFile(), track);
    settle(world);
    expect(world.raycast([2.4, 0.05, 0], [1, 0, 0], 3)).toBeNull();
  });

  it('ignore the car by default and can see it on request', async () => {
    const world = await createWorld(
      testWorldFile({ start: { x: 0, z: 0, yawDeg: 0 } }),
      trackLibrary.load('oval'),
    );
    const car = world.createVehicle({ car: exampleCar, catalog: defaultCatalog });
    for (let i = 0; i < 500; i++) {
      car.applyCommand({ steerAngleRad: 0, motorDuty: 0 });
      world.step(0.001, i * 1000);
    }
    // from above the car, straight down
    expect(world.raycast([0, 0.5, 0], [0, -1, 0], 2)?.target).toEqual({ kind: 'ground' });
    const seen = world.raycast([0, 0.5, 0], [0, -1, 0], 2, { excludeVehicle: false });
    expect(seen?.target).toEqual({ kind: 'vehicle' });
    expect(seen?.distanceM).toBeCloseTo(0.5 - 0.214, 2);
  });
});

describe('obstacle editing', () => {
  it('adds, moves and removes obstacles while the world exists', async () => {
    const world = await createWorld(testWorldFile(), trackLibrary.load('oval'));
    const ray = (): string | undefined => {
      settle(world);
      const hit = world.raycast([2.4, 0.1, 0], [0, 0, -1], 5);
      return hit?.target.kind === 'obstacle' ? hit.target.id : hit?.target.kind;
    };
    expect(world.obstacles()).toEqual([]);

    const id = world.addObstacle({ type: 'box', positionM: { x: 2.4, z: -2 }, yawDeg: 0 });
    expect(id).toMatch(/\S/);
    expect(ray()).toBe(id);
    expect(world.obstacles().map((o) => o.id)).toEqual([id]);

    world.moveObstacle(id, { x: 0, z: -2 }, 45);
    expect(ray()).not.toBe(id);
    const moved = world.obstacles()[0]!;
    expect(moved.pose.position).toEqual([0, 0, -2]);
    expect(moved.pose.rotation[1]).toBeCloseTo(Math.sin(Math.PI / 8), 6);

    world.moveObstacle(id, { x: 2.4, z: -1 }, 0);
    expect(ray()).toBe(id);

    world.removeObstacle(id);
    expect(ray()).not.toBe(id);
    expect(world.obstacles()).toEqual([]);
  });

  it('keeps ids unique and rejects bad edits', async () => {
    const world = await createWorld(
      testWorldFile({ obstacles: [cone('a', 0, -3)] }),
      trackLibrary.load('oval'),
    );
    expect(() => world.addObstacle(cone('a', 1, 1))).toThrow(/already/);
    const ids = new Set([
      world.addObstacle(cone('', 0, 0) as Obstacle & { id?: undefined }),
      world.addObstacle({ type: 'cone', positionM: { x: 1, z: 1 }, yawDeg: 0 }),
    ]);
    expect(ids.size).toBe(2);
    expect(ids.has('a')).toBe(false);
    expect(() => world.moveObstacle('nope', { x: 0, z: 0 }, 0)).toThrow(/no obstacle/);
    expect(() => world.removeObstacle('nope')).not.toThrow();
  });

  it('writes the current layout back as a world file', async () => {
    const world = await createWorld(
      testWorldFile({
        obstacles: [
          cone('a', 0, -3),
          { id: 'b', type: 'box', positionM: { x: 1, z: -3 }, yawDeg: 30 },
        ],
      }),
      trackLibrary.load('oval'),
    );
    world.moveObstacle('a', { x: 0.5, z: -3.5 }, 90);
    world.removeObstacle('b');
    const file = world.toWorldFile();
    expect(file.name).toBe('test');
    expect(file.trackId).toBe('oval');
    expect(file.obstacles).toEqual([
      { id: 'a', type: 'cone', positionM: { x: 0.5, z: -3.5 }, yawDeg: 90 },
    ]);
    // and it loads again
    const again = await createWorld(file, trackLibrary.load('oval'));
    expect(again.obstacles().map((o) => o.id)).toEqual(['a']);
  });
});

describe('vehicle', () => {
  it('starts at the world file start pose, else the track start', async () => {
    const track = trackLibrary.load('oval');
    const defaulted = await createWorld(testWorldFile(), track);
    const a = defaulted.createVehicle({ car: exampleCar, catalog: defaultCatalog }).state().pose;
    expect(a.position[0]).toBeCloseTo(track.start.positionM.x, 3);
    expect(a.position[2]).toBeCloseTo(track.start.positionM.z, 3);

    const custom = await createWorld(testWorldFile({ start: { x: 1, z: 2, yawDeg: 0 } }), track);
    const b = custom.createVehicle({ car: exampleCar, catalog: defaultCatalog }).state().pose;
    expect(b.position[0]).toBeCloseTo(1, 3);
    expect(b.position[2]).toBeCloseTo(2, 3);
  });

  it('allows one vehicle per world', async () => {
    const world = await createWorld(testWorldFile(), trackLibrary.load('oval'));
    world.createVehicle({ car: exampleCar, catalog: defaultCatalog });
    expect(() => world.createVehicle({ car: exampleCar, catalog: defaultCatalog })).toThrow(
      /already/,
    );
  });
});
