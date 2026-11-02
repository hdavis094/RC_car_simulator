import type { Obstacle, ObstacleType, Track, World as WorldFile } from '@rcsim/schema';
import type { Pose, Vec3 } from './math.ts';
import type { Vehicle, VehicleSpec } from './vehicle.ts';

/** An obstacle as it is in the running world. */
export interface ObstacleState {
  /** Stable id: from the world file, or assigned when added. */
  readonly id: string;
  readonly type: ObstacleType;
  readonly pose: Pose;
}

export interface RaycastHit {
  /** Distance from the ray origin, metres. */
  readonly distanceM: number;
  readonly point: Vec3;
  readonly normal: Vec3;
  /** What was hit: an obstacle id, the track wall, the ground, or the car itself. */
  readonly target:
    | { readonly kind: 'obstacle'; readonly id: string }
    | { readonly kind: 'wall' | 'ground' | 'vehicle' };
}

export interface RaycastOptions {
  /** Ignore the vehicle's own colliders (sensors mounted on it). Default true. */
  readonly excludeVehicle?: boolean;
}

/** The vehicle touching something during a step. */
export interface CollisionEvent {
  /** Sim time of the tick in which contact began, µs. */
  readonly tUs: number;
  readonly with: { readonly kind: 'obstacle'; readonly id: string } | { readonly kind: 'wall' };
  /** Contact impulse, N·s, for "how hard" (0 if the engine can't say). */
  readonly impulseNs: number;
}

export interface WorldStepEvents {
  /**
   * Contacts that began during this step, not ongoing ones. A re-touch of the
   * same target within a short bounce gap is the same contact, so one hit gives
   * one event. Each edge of the track is its own target.
   */
  readonly collisions: readonly CollisionEvent[];
}

/**
 * The physical world: ground, track walls, obstacles and the vehicle. It owns
 * the physics engine, so it alone advances physics.
 */
export interface World {
  readonly track: Track;
  /** Creates the car in the world at the start pose (world file `start`, else the track's). */
  createVehicle(spec: VehicleSpec): Vehicle;
  /**
   * Advances physics by `dtS` seconds, the vehicle included, after
   * `vehicle.applyCommand`. `nowUs` stamps the returned events.
   */
  step(dtS: number, nowUs: number): WorldStepEvents;
  /** Casts a ray; the nearest hit within `maxDistanceM`, or null. `direction` is unit length. */
  raycast(
    origin: Vec3,
    direction: Vec3,
    maxDistanceM: number,
    options?: RaycastOptions,
  ): RaycastHit | null;

  // Obstacle editing (the 3D World editor), allowed between steps.
  obstacles(): readonly ObstacleState[];
  /** Adds an obstacle and returns its id (the given one, or a new unique one). */
  addObstacle(obstacle: Obstacle): string;
  /** Moves an obstacle on the ground. Throws on an unknown id. */
  moveObstacle(
    id: string,
    position: { readonly x: number; readonly z: number },
    yawDeg: number,
  ): void;
  removeObstacle(id: string): void;
  /** The current layout as a world file, for saving to `worlds/*.json`. */
  toWorldFile(): WorldFile;
}

/** Loads a world file onto its track. Implemented by P1-A. */
export type CreateWorld = (world: WorldFile, track: Track) => Promise<World>;

/**
 * The built-in tracks (`assets/tracks/<id>.json`), by id: `oval`, `technical`.
 * Implemented by P1-A; the sim host, the CLI and main (for the renderer's
 * track mesh, via IPC `worldEdit.loadTrack`) all resolve `World.trackId` with it.
 */
export interface TrackLibrary {
  ids(): readonly string[];
  /** Throws on an unknown id. */
  load(id: string): Track;
}
