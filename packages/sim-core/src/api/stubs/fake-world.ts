import type { Obstacle, Track, World as WorldFile } from '@rcsim/schema';
import type { Pose, Quat, Vec3 } from '../math.ts';
import type { Vehicle, VehicleCommand, VehicleSpec, VehicleState, WheelState } from '../vehicle.ts';
import type {
  CollisionEvent,
  ObstacleState,
  RaycastHit,
  RaycastOptions,
  World,
  WorldStepEvents,
} from '../world.ts';

const yawQuat = (yawDeg: number): Quat => {
  const half = (yawDeg * Math.PI) / 360;
  return [0, Math.sin(half), 0, Math.cos(half)];
};

/** Obstacles are treated as spheres of this radius by the fake raycast and collisions. */
const OBSTACLE_RADIUS_M = 0.15;

/**
 * A car that drives in a straight line along its start heading at
 * `motorDuty × maxSpeedMps`, ignoring steering. For tests that need motion
 * but not physics.
 */
export class FakeVehicle implements Vehicle {
  readonly maxSpeedMps: number;
  #command: VehicleCommand = { steerAngleRad: 0, motorDuty: 0 };
  #position: [number, number, number];
  readonly #yawDeg: number;
  #speed = 0;
  #spin = 0;

  constructor(start: { x: number; z: number; yawDeg: number }, maxSpeedMps = 3) {
    this.#position = [start.x, 0, start.z];
    this.#yawDeg = start.yawDeg;
    this.maxSpeedMps = maxSpeedMps;
  }

  applyCommand(command: VehicleCommand): void {
    this.#command = command;
  }

  /** Moves the car; called by FakeWorld.step. */
  advance(dtS: number): void {
    this.#speed = this.#command.motorDuty * this.maxSpeedMps;
    const yaw = (this.#yawDeg * Math.PI) / 180;
    this.#position = [
      this.#position[0] - Math.sin(yaw) * this.#speed * dtS,
      0,
      this.#position[2] - Math.cos(yaw) * this.#speed * dtS,
    ];
    this.#spin += (this.#speed / 0.05) * dtS;
  }

  state(): VehicleState {
    const yaw = (this.#yawDeg * Math.PI) / 180;
    const velocity: Vec3 = [-Math.sin(yaw) * this.#speed, 0, -Math.cos(yaw) * this.#speed];
    const rotation = yawQuat(this.#yawDeg);
    const wheel = (dx: number, dz: number): WheelState => ({
      position: [this.#position[0] + dx, 0.05, this.#position[2] + dz],
      rotation,
      steerRad: 0,
      spinRad: this.#spin,
      inContact: true,
    });
    return {
      pose: { position: this.#position, rotation },
      velocity,
      angularVelocity: [0, 0, 0],
      forwardSpeedMps: this.#speed,
      acceleration: [0, 0, 0],
      command: this.#command,
      wheels: [wheel(-0.12, -0.17), wheel(0.12, -0.17), wheel(-0.12, 0.17), wheel(0.12, 0.17)],
    };
  }

  chassisToWorld(offsetMm: { x: number; y: number; z: number }, yawDeg: number): Pose {
    return {
      position: [
        this.#position[0] + offsetMm.x / 1000,
        offsetMm.y / 1000,
        this.#position[2] + offsetMm.z / 1000,
      ],
      rotation: yawQuat(this.#yawDeg + yawDeg),
    };
  }
}

/**
 * A flat world with no walls: obstacles are spheres for raycasts and
 * collisions, and the vehicle is a FakeVehicle. For tests of neighbours.
 */
export class FakeWorld implements World {
  readonly track: Track;
  readonly #file: WorldFile;
  readonly #obstacles = new Map<string, ObstacleState>();
  readonly #touching = new Set<string>();
  #vehicle: FakeVehicle | undefined;
  #nextId = 1;

  constructor(file: WorldFile, track: Track) {
    this.#file = file;
    this.track = track;
    for (const obstacle of file.obstacles) this.addObstacle(obstacle);
  }

  createVehicle(_spec: VehicleSpec): Vehicle {
    const start = this.#file.start ?? this.track.start;
    this.#vehicle = new FakeVehicle({ ...start.positionM, yawDeg: start.yawDeg });
    return this.#vehicle;
  }

  step(dtS: number, nowUs: number): WorldStepEvents {
    this.#vehicle?.advance(dtS);
    const collisions: CollisionEvent[] = [];
    const car = this.#vehicle?.state().pose.position;
    if (car) {
      for (const obstacle of this.#obstacles.values()) {
        const [x, , z] = obstacle.pose.position;
        const touching = Math.hypot(x - car[0], z - car[2]) < OBSTACLE_RADIUS_M + 0.2;
        if (touching && !this.#touching.has(obstacle.id)) {
          collisions.push({
            tUs: nowUs,
            with: { kind: 'obstacle', id: obstacle.id },
            impulseNs: 0,
          });
        }
        if (touching) this.#touching.add(obstacle.id);
        else this.#touching.delete(obstacle.id);
      }
    }
    return { collisions };
  }

  raycast(
    origin: Vec3,
    direction: Vec3,
    maxDistanceM: number,
    _options?: RaycastOptions,
  ): RaycastHit | null {
    let best: RaycastHit | null = null;
    for (const obstacle of this.#obstacles.values()) {
      const c = obstacle.pose.position;
      const oc: Vec3 = [c[0] - origin[0], c[1] + OBSTACLE_RADIUS_M - origin[1], c[2] - origin[2]];
      const along = oc[0] * direction[0] + oc[1] * direction[1] + oc[2] * direction[2];
      const perp2 = oc[0] ** 2 + oc[1] ** 2 + oc[2] ** 2 - along ** 2;
      if (along < 0 || perp2 > OBSTACLE_RADIUS_M ** 2) continue;
      const distanceM = along - Math.sqrt(OBSTACLE_RADIUS_M ** 2 - perp2);
      if (distanceM > maxDistanceM || (best && best.distanceM <= distanceM)) continue;
      const point: Vec3 = [
        origin[0] + direction[0] * distanceM,
        origin[1] + direction[1] * distanceM,
        origin[2] + direction[2] * distanceM,
      ];
      best = {
        distanceM,
        point,
        normal: [-direction[0], -direction[1], -direction[2]],
        target: { kind: 'obstacle', id: obstacle.id },
      };
    }
    return best;
  }

  obstacles(): readonly ObstacleState[] {
    return [...this.#obstacles.values()];
  }

  addObstacle(obstacle: Obstacle): string {
    let id = obstacle.id ?? `obstacle-${this.#nextId++}`;
    while (obstacle.id === undefined && this.#obstacles.has(id)) id = `obstacle-${this.#nextId++}`;
    this.#obstacles.set(id, {
      id,
      type: obstacle.type,
      pose: {
        position: [obstacle.positionM.x, 0, obstacle.positionM.z],
        rotation: yawQuat(obstacle.yawDeg),
      },
    });
    return id;
  }

  moveObstacle(id: string, position: { x: number; z: number }, yawDeg: number): void {
    const obstacle = this.#obstacles.get(id);
    if (!obstacle) throw new Error(`no obstacle "${id}"`);
    this.#obstacles.set(id, {
      ...obstacle,
      pose: { position: [position.x, 0, position.z], rotation: yawQuat(yawDeg) },
    });
  }

  removeObstacle(id: string): void {
    this.#obstacles.delete(id);
  }

  toWorldFile(): WorldFile {
    return {
      ...this.#file,
      obstacles: this.obstacles().map((o) => {
        const [, y, , w] = o.pose.rotation;
        return {
          id: o.id,
          type: o.type,
          positionM: { x: o.pose.position[0], z: o.pose.position[2] },
          yawDeg: (2 * Math.atan2(y, w) * 180) / Math.PI,
        };
      }),
    };
  }
}
