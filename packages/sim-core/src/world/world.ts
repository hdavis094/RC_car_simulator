import type {
  Collider,
  EventQueue,
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
  | { readonly kind: 'wall' }
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

const yawRad = (yawDeg: number): number => (yawDeg * Math.PI) / 180;

/**
 * The physical world: ground, track walls, obstacles and the car, stepped by Rapier.
 *
 * Rapier updates its spatial index only inside a step (a zero-length step to
 * force it corrupts the car's collider, so none is used). So the scene is
 * complete for `raycast` after the first `step`, and obstacle edits are
 * visible to `raycast` from the step after the edit. Contacts follow the
 * same rule. A Run always steps before it casts sensor rays, so it never
 * sees stale results.
 */
export class PhysicsWorld implements World {
  readonly track: Track;
  readonly #rapier: Rapier;
  readonly #world: RapierWorld;
  readonly #events: EventQueue;
  readonly #file: WorldFile;
  readonly #targets = new Map<number, Target>();
  readonly #obstacles = new Map<string, ObstacleRecord>();
  readonly #contacts = new ContactTracker();
  #vehicle: RapierVehicle | undefined;
  #nextId = 1;

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

  #register(collider: Collider, target: Target): void {
    this.#targets.set(collider.handle, target);
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
    for (const side of [offset, -offset]) {
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
        this.#register(collider, { kind: 'wall' });
      }
    }
  }

  createVehicle(spec: VehicleSpec): Vehicle {
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
    this.#world.timestep = dtS;
    this.#vehicle?.preStep(dtS);
    this.#world.step(this.#events);
    this.#vehicle?.postStep(dtS);
    const collisions: CollisionEvent[] = [];
    this.#events.drainCollisionEvents((h1, h2, started) => {
      const vehicle = this.#vehicle;
      if (!vehicle) return;
      const other =
        h1 === vehicle.collider.handle ? h2 : h2 === vehicle.collider.handle ? h1 : null;
      const target = other === null ? undefined : this.#targets.get(other);
      if (other === null || !target) return;
      if (target.kind !== 'obstacle' && target.kind !== 'wall') return;
      const key = target.kind === 'wall' ? 'wall' : `obstacle:${target.id}`;
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
    const excludeVehicle = options?.excludeVehicle ?? true;
    const filter = GROUP.ground | GROUP.solid | (excludeVehicle ? 0 : GROUP.vehicle);
    const ray = new this.#rapier.Ray(
      { x: origin[0], y: origin[1], z: origin[2] },
      { x: direction[0], y: direction[1], z: direction[2] },
    );
    const hit = this.#world.castRayAndGetNormal(
      ray,
      maxDistanceM,
      true,
      undefined,
      groups(0xffff, filter),
    );
    if (!hit) return null;
    const target = this.#targets.get(hit.collider.handle) ?? { kind: 'ground' as const };
    return {
      distanceM: hit.timeOfImpact,
      point: [
        origin[0] + direction[0] * hit.timeOfImpact,
        origin[1] + direction[1] * hit.timeOfImpact,
        origin[2] + direction[2] * hit.timeOfImpact,
      ],
      normal: [hit.normal.x, hit.normal.y, hit.normal.z],
      target,
    };
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
    const obstacle = this.#obstacles.get(id);
    if (!obstacle) throw new Error(`no obstacle "${id}"`);
    const body = obstacle.collider.parent();
    const q = quatY(yawRad(yawDeg));
    body?.setTranslation({ x: position.x, y: 0, z: position.z }, true);
    body?.setRotation({ x: q[0], y: q[1], z: q[2], w: q[3] }, true);
    obstacle.x = position.x;
    obstacle.z = position.z;
    obstacle.yawDeg = yawDeg;
  }

  removeObstacle(id: string): void {
    const obstacle = this.#obstacles.get(id);
    if (!obstacle) return;
    const body = obstacle.collider.parent();
    this.#targets.delete(obstacle.collider.handle);
    this.#contacts.forget(`obstacle:${id}`);
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

/** Loads a world file onto its track. */
export const createWorld: CreateWorld = async (file, track) =>
  new PhysicsWorld(await loadRapier(), file, track);
