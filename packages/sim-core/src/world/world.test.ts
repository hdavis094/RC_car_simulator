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

describe('raycasts on a world that has not stepped, and after edits', () => {
  it('see the walls, ground and obstacles from the start, with no step', async () => {
    const world = await createWorld(
      testWorldFile({ obstacles: [cone('a', 2.4, -1)] }),
      trackLibrary.load('oval'),
    );
    expect(world.raycast([2.4, 0.1, 0], [0, 0, -1], 5)?.target).toEqual({
      kind: 'obstacle',
      id: 'a',
    });
    expect(world.raycast([2.4, 0.05, 0], [1, 0, 0], 3)?.target).toEqual({ kind: 'wall' });
    expect(world.raycast([0, 0.5, 0], [0, -1, 0], 2)?.target).toEqual({ kind: 'ground' });
  });

  it('see a paused edit at once: add, move and remove, with no step in between', async () => {
    const world = await createWorld(testWorldFile(), trackLibrary.load('oval'));
    settle(world);
    const cast = (x: number) => world.raycast([x, 0.1, 0], [0, 0, -1], 5)?.target;
    const id = world.addObstacle({ type: 'box', positionM: { x: 2.4, z: -2 }, yawDeg: 0 });
    expect(cast(2.4)).toEqual({ kind: 'obstacle', id });
    world.moveObstacle(id, { x: 2.0, z: -2 }, 0);
    expect(cast(2.4)?.kind).not.toBe('obstacle');
    expect(cast(2.0)).toEqual({ kind: 'obstacle', id });
    // the same after more steps, and a step does not change the answer
    settle(world);
    expect(cast(2.0)).toEqual({ kind: 'obstacle', id });
    world.removeObstacle(id);
    expect(cast(2.0)?.kind).not.toBe('obstacle');
  });

  it('see the car where the last step left it, including after an edit', async () => {
    const world = await createWorld(
      testWorldFile({ start: { x: 0, z: 0, yawDeg: 0 } }),
      trackLibrary.load('oval'),
    );
    const car = world.createVehicle({ car: exampleCar, catalog: defaultCatalog });
    for (let i = 0; i < 300; i++) {
      car.applyCommand({ steerAngleRad: 0, motorDuty: 0 });
      world.step(0.001, i * 1000);
    }
    world.addObstacle(cone('x', 1, 1));
    const seen = world.raycast([0, 0.5, 0], [0, -1, 0], 2, { excludeVehicle: false });
    expect(seen?.target).toEqual({ kind: 'vehicle' });
    expect(world.raycast([0, 0.5, 0], [0, -1, 0], 2)?.target).toEqual({ kind: 'ground' });
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

describe('the suspension and edits made while paused', () => {
  async function settledCar(extra: Parameters<typeof testWorldFile>[0] = {}) {
    const world = await createWorld(
      testWorldFile({ start: { x: 2.4, z: 0, yawDeg: 0 }, ...extra }),
      trackLibrary.load('oval'),
    );
    const car = world.createVehicle({ car: exampleCar, catalog: defaultCatalog });
    let tick = 0;
    const hits = { count: 0 };
    const step = (n: number, duty = 0) => {
      for (let i = 0; i < n; i++) {
        car.applyCommand({ steerAngleRad: 0, motorDuty: duty });
        hits.count += world.step(0.001, ++tick * 1000).collisions.length;
      }
    };
    step(1000);
    return { world, car, step, hits };
  }

  it('lets a ramp edited while paused lift the wheels in the very next step', async () => {
    const { world, car, step } = await settledCar();
    expect(car.state().wheels[0].position[1]).toBeCloseTo(0.055, 2);
    // a ramp under the front wheels: its surface is about 2.7 cm up at the front-left wheel
    world.addObstacle({ type: 'ramp', positionM: { x: 2.4, z: -0.3 }, yawDeg: 0 });
    step(1);
    expect(car.state().wheels[0].position[1]).toBeGreaterThan(0.07);
    // moving it away is seen at once, too
    const id = world.obstacles()[0]!.id;
    world.moveObstacle(id, { x: 2.4, z: -9 }, 0);
    step(300);
    expect(car.state().wheels[0].position[1]).toBeCloseTo(0.055, 2);
  });

  it('changes nothing about the car: edits that need an index refresh leave its motion bit-identical', async () => {
    const a = await settledCar();
    const b = await settledCar();
    a.step(1, 0.3);
    b.step(1, 0.3);
    b.world.addObstacle({ type: 'ramp', positionM: { x: -20, z: -20 }, yawDeg: 0 }); // far away
    for (let i = 0; i < 200; i++) {
      a.step(1, 0.3);
      b.step(1, 0.3);
      expect(b.car.state()).toEqual(a.car.state());
    }
    b.world.moveObstacle(b.world.obstacles()[0]!.id, { x: -21, z: -20 }, 10);
    for (let i = 0; i < 200; i++) {
      a.step(1, 0.3);
      b.step(1, 0.3);
      expect(b.car.state()).toEqual(a.car.state());
    }
  });

  it('does not count a hit twice when a ramp edit happens while the car is against an obstacle', async () => {
    const { world, step, hits } = await settledCar({ obstacles: [cone('c', 2.4, -0.6)] });
    step(1500, 0.5); // drives into the cone and pushes against it
    expect(hits.count).toBe(1);
    world.addObstacle({ type: 'ramp', positionM: { x: -20, z: -20 }, yawDeg: 0 });
    step(300, 0.5);
    world.moveObstacle(world.obstacles().find((o) => o.type === 'ramp')!.id, { x: -21, z: -20 }, 0);
    step(300, 0.5);
    expect(hits.count).toBe(1);
  });
});
