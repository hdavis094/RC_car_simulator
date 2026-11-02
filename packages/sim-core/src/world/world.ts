import type {
  Collider,
  EventQueue,
  Ray,
  World as RapierWorld,
} from '@dimforge/rapier3d-deterministic-compat';
import type { Obstacle, Track, World as WorldFile } from '@rcsim/schema';
import type { Quat, Vec3 } from '../api/math.ts';
import type { Vehicle, VehicleSpec } from '../api/vehicle.ts';
import type {
  CollisionEvent,
  CreateWorld,
  ObstacleState,
  RaycastHit,
  RaycastOptions,
  World,
  WorldStepEvents,
} from '../api/world.ts';
import { RapierVehicle } from '../vehicle/vehicle.ts';
import { vehicleParams } from '../vehicle/params.ts';
import { ContactTracker } from './contacts.ts';
import { obstacleCollider } from './obstacles.ts';
import { quatY } from './quat.ts';
import { GROUP, groups, loadRapier, type Rapier } from './rapier.ts';
import { offsetLoop, sampleCentreline, simplifyLoop, type Point2 } from './track-geometry.ts';

const GRAVITY = 9.81;
const WALL_THICKNESS_M = 0.04;
/** Wall pieces may deviate this far from the true curve. */
const WALL_TOLERANCE_M = 0.004;

type Target =
  | { readonly kind: 'obstacle'; readonly id: string }
  | { readonly kind: 'wall'; readonly edge: 'left' | 'right' }
  | { readonly kind: 'ground' }
  | { readonly kind: 'vehicle' };

interface ObstacleRecord {
  readonly id: string;
  readonly type: Obstacle['type'];
  readonly collider: Collider;
  x: number;
  z: number;
  yawDeg: number;
}

/** The contact-tracking key of something the car can hit. */
const contactKey = (target: Target & { kind: 'obstacle' | 'wall' }): string =>
  target.kind === 'wall' ? `wall:${target.edge}` : `obstacle:${target.id}`;

/** A raycast target as the API reports it (a wall's edge stays internal). */
function publicTarget(target: Target | undefined): RaycastHit['target'] {
  if (target === undefined) return { kind: 'ground' };
  return target.kind === 'obstacle' ? target : { kind: target.kind };
}

interface RayFound {
  readonly handle: number;
  readonly toi: number;
  readonly normal: Vec3;
}

const yawRad = (yawDeg: number): number => (yawDeg * Math.PI) / 180;

/**
 * The physical world: ground, track walls, obstacles and the car, stepped by Rapier.
 *
 * Rapier 0.21 refreshes its spatial index (the structure suspension and
 * query rays use) only inside a step, and has no call to do it on demand; a
 * zero-length step to force it corrupts the car's collider, so none is
 * used. Instead:
 *
 * - **Raycasts** are always current. Until the first step, and after any
 *   obstacle edit, the index is out of date, so `raycast` poses the
 *   colliders (`propagateModifiedBodyPositionsToColliders`, which advances
 *   nothing) and tests them one by one. After a step it uses the index.
 * - **Physics** sees edits at the next step, which refreshes the index and
 *   detects contacts. The car's suspension is queried after that step (see
 *   `RapierVehicle.afterStep`), so it never reads a stale index.
 */
export class PhysicsWorld implements World {
  readonly track: Track;
  readonly #rapier: Rapier;
  readonly #world: RapierWorld;
  readonly #events: EventQueue;
  readonly #file: WorldFile;
  readonly #targets = new Map<number, Target>();
  /** Every collider a ray can hit, by handle, for the raycast used while the index is stale. */
  readonly #hittable = new Map<number, Collider>();
  readonly #obstacles = new Map<string, ObstacleRecord>();
  readonly #contacts = new ContactTracker();
  #vehicle: RapierVehicle | undefined;
  #nextId = 1;
  /** True when Rapier's spatial index lacks edits: before the first step, and after an edit. */
  #indexStale = true;
  #disposed = false;

  constructor(rapier: Rapier, file: WorldFile, track: Track) {
    this.#rapier = rapier;
    this.#file = file;
    this.track = track;
    this.#world = new rapier.World({ x: 0, y: -GRAVITY, z: 0 });
    this.#events = new rapier.EventQueue(true);
    this.#buildGround();
    this.#buildWalls();
    for (const obstacle of file.obstacles) this.#add(obstacle);
  }

  /** Frees Rapier's WebAssembly memory. Safe to call twice; the world is unusable for physics afterwards. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#events.free();
    this.#world.free();
    this.#hittable.clear();
    this.#targets.clear();
  }

  #live(): void {
    if (this.#disposed) throw new Error('the world has been disposed');
  }

  #register(collider: Collider, target: Target): void {
    this.#targets.set(collider.handle, target);
    this.#hittable.set(collider.handle, collider);
  }

  #buildGround(): void {
    const r = this.#rapier;
    const ground = this.#world.createCollider(
      r.ColliderDesc.cuboid(200, 0.5, 200)
        .setTranslation(0, -0.5, 0)
        .setFriction(1)
        .setCollisionGroups(groups(GROUP.ground, 0xffff)),
    );
    this.#register(ground, { kind: 'ground' });
  }

  /** Walls along both edges of the lane: straight pieces on straights, short ones on curves. */
  #buildWalls(): void {
    const height = this.track.wallHeightM;
    if (height <= 0) return;
    const r = this.#rapier;
    const centre = sampleCentreline(this.track).points;
    const offset = this.track.widthM / 2 + WALL_THICKNESS_M / 2;
    // The loop's left edge is at +offset, its right edge at -offset.
    for (const [side, edge] of [
      [offset, 'left'],
      [-offset, 'right'],
    ] as const) {
      const loop = simplifyLoop(offsetLoop(centre, side), WALL_TOLERANCE_M);
      for (let i = 0; i < loop.length; i++) {
        const a = loop[i] as Point2;
        const b = loop[(i + 1) % loop.length] as Point2;
        const length = Math.hypot(b.x - a.x, b.z - a.z);
        if (length < 1e-4) continue;
        // The cuboid's long axis is local Z, rotated about Y onto the segment.
        const q = quatY(Math.atan2(b.x - a.x, b.z - a.z));
        const collider = this.#world.createCollider(
          r.ColliderDesc.cuboid(WALL_THICKNESS_M / 2, height / 2, length / 2 + WALL_THICKNESS_M / 2)
            .setTranslation((a.x + b.x) / 2, height / 2, (a.z + b.z) / 2)
            .setRotation({ x: q[0], y: q[1], z: q[2], w: q[3] })
            .setFriction(0.2)
            .setCollisionGroups(groups(GROUP.solid, 0xffff)),
        );
        this.#register(collider, { kind: 'wall', edge });
      }
    }
  }

  createVehicle(spec: VehicleSpec): Vehicle {
    this.#live();
    if (this.#vehicle) throw new Error('this world already has a vehicle');
    const start = this.#file.start ?? this.track.start;
    this.#vehicle = new RapierVehicle(this.#rapier, this.#world, vehicleParams(spec), {
      ...start.positionM,
      yawDeg: start.yawDeg,
    });
    this.#register(this.#vehicle.collider, { kind: 'vehicle' });
    return this.#vehicle;
  }

  step(dtS: number, nowUs: number): WorldStepEvents {
    this.#live();
    this.#world.timestep = dtS;
    this.#world.step(this.#events);
    this.#indexStale = false;
    this.#vehicle?.afterStep(dtS);
    const collisions: CollisionEvent[] = [];
    this.#events.drainCollisionEvents((h1, h2, started) => {
      const vehicle = this.#vehicle;
      if (!vehicle) return;
      const other =
        h1 === vehicle.collider.handle ? h2 : h2 === vehicle.collider.handle ? h1 : null;
      const target = other === null ? undefined : this.#targets.get(other);
      if (other === null || !target) return;
      if (target.kind !== 'obstacle' && target.kind !== 'wall') return;
      const key = contactKey(target);
      if (!started) {
        this.#contacts.stopped(key, nowUs);
      } else if (this.#contacts.started(key, nowUs)) {
        collisions.push({
          tUs: nowUs,
          with: target.kind === 'wall' ? { kind: 'wall' } : { kind: 'obstacle', id: target.id },
          impulseNs: this.#impulse(vehicle.collider, other),
        });
      }
    });
    return { collisions };
  }

  /** Total contact impulse between the car and a collider this step; 0 if unknown. */
  #impulse(vehicle: Collider, otherHandle: number): number {
    const other = this.#world.getCollider(otherHandle);
    let total = 0;
    this.#world.contactPair(vehicle, other, (manifold) => {
      for (let i = 0; i < manifold.numContacts(); i++) total += manifold.contactImpulse(i);
    });
    return total;
  }

  raycast(
    origin: Vec3,
    direction: Vec3,
    maxDistanceM: number,
    options?: RaycastOptions,
  ): RaycastHit | null {
    if (this.#disposed) return null;
    const excludeVehicle = options?.excludeVehicle ?? true;
    const ray = new this.#rapier.Ray(
      { x: origin[0], y: origin[1], z: origin[2] },
      { x: direction[0], y: direction[1], z: direction[2] },
    );
    const found = this.#indexStale
      ? this.#scan(ray, maxDistanceM, excludeVehicle)
      : this.#indexed(ray, maxDistanceM, excludeVehicle);
    if (!found) return null;
    const { handle, toi, normal } = found;
    return {
      distanceM: toi,
      point: [
        origin[0] + direction[0] * toi,
        origin[1] + direction[1] * toi,
        origin[2] + direction[2] * toi,
      ],
      normal,
      target: publicTarget(this.#targets.get(handle)),
    };
  }

  /** Nearest hit through Rapier's spatial index (current: no edits since the last step). */
  #indexed(ray: Ray, maxDistanceM: number, excludeVehicle: boolean): RayFound | null {
    const filter = GROUP.ground | GROUP.solid | (excludeVehicle ? 0 : GROUP.vehicle);
    const hit = this.#world.castRayAndGetNormal(
      ray,
      maxDistanceM,
      true,
      undefined,
      groups(0xffff, filter),
    );
    return hit
      ? {
          handle: hit.collider.handle,
          toi: hit.timeOfImpact,
          normal: [hit.normal.x, hit.normal.y, hit.normal.z],
        }
      : null;
  }

  /**
   * Nearest hit by testing every collider, for when the index lacks edits.
   * Only poses the colliders at their bodies' current positions; nothing moves.
   */
  #scan(ray: Ray, maxDistanceM: number, excludeVehicle: boolean): RayFound | null {
    this.#world.propagateModifiedBodyPositionsToColliders();
    let best: RayFound | null = null;
    for (const [handle, collider] of this.#hittable) {
      if (excludeVehicle && this.#targets.get(handle)?.kind === 'vehicle') continue;
      const hit = collider.castRayAndGetNormal(ray, maxDistanceM, true);
      if (hit && (best === null || hit.timeOfImpact < best.toi)) {
        best = {
          handle,
          toi: hit.timeOfImpact,
          normal: [hit.normal.x, hit.normal.y, hit.normal.z],
        };
      }
    }
    return best;
  }

  obstacles(): readonly ObstacleState[] {
    return [...this.#obstacles.values()].map((o) => ({
      id: o.id,
      type: o.type,
      pose: {
        position: [o.x, 0, o.z],
        rotation: quatY(yawRad(o.yawDeg)) satisfies Quat,
      },
    }));
  }

  addObstacle(obstacle: Obstacle): string {
    this.#live();
    this.#indexStale = true;
    return this.#add(obstacle);
  }

  #add(obstacle: Obstacle): string {
    if (obstacle.id !== undefined && this.#obstacles.has(obstacle.id)) {
      throw new Error(`obstacle id "${obstacle.id}" is already in the world`);
    }
    let id = obstacle.id;
    if (id === undefined) {
      do id = `obstacle-${this.#nextId++}`;
      while (this.#obstacles.has(id));
    }
    const q = quatY(yawRad(obstacle.yawDeg));
    const collider = this.#world.createCollider(
      obstacleCollider(this.#rapier, obstacle.type)
        .setFriction(0.5)
        .setRestitution(0)
        .setActiveEvents(this.#rapier.ActiveEvents.COLLISION_EVENTS),
      this.#fixedBody(obstacle.positionM.x, obstacle.positionM.z, q),
    );
    this.#register(collider, { kind: 'obstacle', id });
    this.#obstacles.set(id, {
      id,
      type: obstacle.type,
      collider,
      x: obstacle.positionM.x,
      z: obstacle.positionM.z,
      yawDeg: obstacle.yawDeg,
    });
    return id;
  }

  /** A fixed body to hang an obstacle's collider on, so it can be moved as one piece. */
  #fixedBody(x: number, z: number, q: Quat) {
    return this.#world.createRigidBody(
      this.#rapier.RigidBodyDesc.fixed()
        .setTranslation(x, 0, z)
        .setRotation({ x: q[0], y: q[1], z: q[2], w: q[3] }),
    );
  }

  moveObstacle(
    id: string,
    position: { readonly x: number; readonly z: number },
    yawDeg: number,
  ): void {
    this.#live();
    const obstacle = this.#obstacles.get(id);
    if (!obstacle) throw new Error(`no obstacle "${id}"`);
    const body = obstacle.collider.parent();
    const q = quatY(yawRad(yawDeg));
    body?.setTranslation({ x: position.x, y: 0, z: position.z }, true);
    body?.setRotation({ x: q[0], y: q[1], z: q[2], w: q[3] }, true);
    obstacle.x = position.x;
    obstacle.z = position.z;
    obstacle.yawDeg = yawDeg;
    // Pose the collider now (raycasts read it), and start the contact history
    // afresh: the car touching the obstacle where it was is not a touch where it is.
    this.#world.propagateModifiedBodyPositionsToColliders();
    this.#contacts.forget(contactKey({ kind: 'obstacle', id }));
    this.#indexStale = true;
  }

  removeObstacle(id: string): void {
    this.#live();
    const obstacle = this.#obstacles.get(id);
    if (!obstacle) return;
    const body = obstacle.collider.parent();
    this.#targets.delete(obstacle.collider.handle);
    this.#hittable.delete(obstacle.collider.handle);
    this.#contacts.forget(contactKey({ kind: 'obstacle', id }));
    this.#indexStale = true;
    if (body) this.#world.removeRigidBody(body);
    else this.#world.removeCollider(obstacle.collider, true);
    this.#obstacles.delete(id);
  }

  toWorldFile(): WorldFile {
    return {
      ...this.#file,
      obstacles: [...this.#obstacles.values()].map((o) => ({
        id: o.id,
        type: o.type,
        positionM: { x: o.x, z: o.z },
        yawDeg: o.yawDeg,
      })),
    };
  }
}

/** Loads a world file onto its track; the result can be disposed. */
export async function createPhysicsWorld(file: WorldFile, track: Track): Promise<PhysicsWorld> {
  return new PhysicsWorld(await loadRapier(), file, track);
}

export const createWorld: CreateWorld = createPhysicsWorld;
