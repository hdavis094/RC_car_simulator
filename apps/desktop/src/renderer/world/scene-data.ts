import type { ObstacleType, Track, World as WorldFile } from '@rcsim/schema';
import {
  WHEEL_ORDER,
  type ObstacleState,
  type Pose,
  type Quat,
  type StateSnapshot,
  type Vec3,
  type WheelState,
} from '@rcsim/sim-core/api';
import * as THREE from 'three';
import { generateTrackMeshData, type GeneratedTrackMeshData } from './track-mesh.ts';

export type CameraMode = 'follow' | 'orbit' | 'top-down';

export const CAMERA_MODES: readonly CameraMode[] = ['follow', 'orbit', 'top-down'] as const;

/** Obstacle dimensions in metres, matching `packages/sim-core/src/world/obstacles.ts`. */
export const OBSTACLE_DIMENSIONS = {
  cone: { radius: 0.06, height: 0.25 },
  box: { half: 0.15 },
  wall: { halfLength: 0.5, halfHeight: 0.1, halfThickness: 0.025 },
  ramp: { halfWidth: 0.25, halfLength: 0.4, height: 0.08 },
} as const;

/** Default 1/10 chassis and wheel dimensions in metres (Traxxas Slash 2WD). */
export const DEFAULT_CAR_GEOMETRY = {
  bodyWidthM: 0.296,
  bodyHeightM: 0.214,
  bodyLengthM: 0.568,
  bodyClearanceM: 0.04,
  wheelbaseM: 0.335,
  trackWidthM: 0.25,
  wheelRadiusM: 0.054,
  wheelWidthM: 0.045,
} as const;

export interface OrbitCameraState {
  readonly azimuthRad: number;
  readonly elevationRad: number;
  readonly distanceM: number;
}

export const DEFAULT_ORBIT_CAMERA: OrbitCameraState = {
  azimuthRad: 0.55,
  elevationRad: 0.72,
  distanceM: 9.5,
};

export interface CameraTransform {
  readonly position: Vec3;
  readonly target: Vec3;
  readonly up: Vec3;
}

export interface RenderedBeamData {
  readonly key: string;
  readonly instanceId: string;
  readonly beamIndex: number;
  readonly origin: Vec3;
  readonly direction: Vec3;
  readonly maxRangeM: number;
  readonly hitM: number | null;
  readonly lengthM: number;
  readonly endPoint: Vec3;
  readonly hitPoint: Vec3 | null;
}

export interface RenderedObstacleData {
  readonly id: string;
  readonly type: ObstacleType;
  readonly pose: Pose;
  readonly yawDeg: number;
  readonly selected: boolean;
}

export interface RenderedWheelData {
  readonly name: (typeof WHEEL_ORDER)[number];
  readonly position: Vec3;
  readonly rotation: Quat;
  readonly steerRad: number;
  readonly spinRad: number;
  readonly inContact: boolean;
}

export interface WorldSceneData {
  readonly trackMesh: GeneratedTrackMeshData;
  readonly carPose: Pose;
  readonly wheels: readonly RenderedWheelData[];
  readonly sensorBeams: readonly RenderedBeamData[];
  readonly obstacles: readonly RenderedObstacleData[];
}

export function yawDegToQuat(yawDeg: number): Quat {
  const halfYawRad = ((yawDeg * Math.PI) / 180) * 0.5;
  return [0, Math.sin(halfYawRad), 0, Math.cos(halfYawRad)];
}

export function quatToYawDeg(q: Quat): number {
  const [x, y, z, w] = q;
  const sinyCosp = 2 * (w * y + x * z);
  const cosyCosp = 1 - 2 * (y * y + z * z);
  return (Math.atan2(sinyCosp, cosyCosp) * 180) / Math.PI;
}

export function rotateVec3ByQuat(q: Quat, v: Vec3): Vec3 {
  const [qx, qy, qz, qw] = q;
  const [vx, vy, vz] = v;
  const tx = 2 * (qy * vz - qz * vy);
  const ty = 2 * (qz * vx - qx * vz);
  const tz = 2 * (qx * vy - qy * vx);
  return [
    vx + qw * tx + (qy * tz - qz * ty),
    vy + qw * ty + (qz * tx - qx * tz),
    vz + qw * tz + (qx * ty - qy * tx),
  ];
}

/**
 * Builds an idle `StateSnapshot` from the current `WorldFile` and `Track`
 * for displaying the start pose and obstacles before a run has emitted snapshots.
 */
export function defaultSnapshotForWorld(world: WorldFile, track: Track): StateSnapshot {
  const start = world.start ?? track.start;
  const rotation = yawDegToQuat(start.yawDeg);
  const position: Vec3 = [start.positionM.x, 0, start.positionM.z];
  const { wheelbaseM: L, trackWidthM: W, wheelRadiusM: Rw } = DEFAULT_CAR_GEOMETRY;
  const wheelLocalOffsets: readonly Vec3[] = [
    [-W / 2, Rw, -L / 2],
    [W / 2, Rw, -L / 2],
    [-W / 2, Rw, L / 2],
    [W / 2, Rw, L / 2],
  ];

  const wheels: WheelState[] = wheelLocalOffsets.map((local) => {
    const worldOffset = rotateVec3ByQuat(rotation, local);
    return {
      position: [
        position[0] + worldOffset[0],
        position[1] + worldOffset[1],
        position[2] + worldOffset[2],
      ],
      rotation,
      steerRad: 0,
      spinRad: 0,
      inContact: true,
    };
  });

  const obstacles: ObstacleState[] = world.obstacles.map((obs, index) => ({
    id: obs.id ?? `obstacle-${index + 1}`,
    type: obs.type,
    pose: {
      position: [obs.positionM.x, 0, obs.positionM.z],
      rotation: yawDegToQuat(obs.yawDeg),
    },
  }));

  return {
    tick: 0,
    timeUs: 0,
    status: 'ready',
    car: {
      pose: { position, rotation },
      velocity: [0, 0, 0],
      forwardSpeedMps: 0,
      command: { steerAngleRad: 0, motorDuty: 0 },
      wheels,
    },
    sensors: [],
    obstacles,
    laps: { count: 0, lapTimesUs: [] },
    collisions: { count: 0, last: null },
  };
}

export function extractRenderedBeams(snapshot: StateSnapshot): RenderedBeamData[] {
  const sensorBeams: RenderedBeamData[] = [];
  for (const sensor of snapshot.sensors) {
    sensor.beams.forEach((beam, beamIndex) => {
      const lengthM = beam.hitM ?? beam.maxRangeM;
      const endPoint: Vec3 = [
        beam.origin[0] + beam.direction[0] * lengthM,
        beam.origin[1] + beam.direction[1] * lengthM,
        beam.origin[2] + beam.direction[2] * lengthM,
      ];
      sensorBeams.push({
        key: `${sensor.instanceId}:${beamIndex}`,
        instanceId: sensor.instanceId,
        beamIndex,
        origin: beam.origin,
        direction: beam.direction,
        maxRangeM: beam.maxRangeM,
        hitM: beam.hitM,
        lengthM,
        endPoint,
        hitPoint: beam.hitM !== null ? endPoint : null,
      });
    });
  }
  return sensorBeams;
}

/**
 * Converts a `StateSnapshot` and `Track` into `WorldSceneData` for rendering.
 */
export function buildWorldSceneData(
  snapshot: StateSnapshot,
  track: Track,
  selectedObstacleId: string | null = null,
): WorldSceneData {
  const trackMesh = generateTrackMeshData(track);
  const wheels: RenderedWheelData[] = WHEEL_ORDER.map((name, i) => {
    const w = snapshot.car.wheels[i];
    return {
      name,
      position: w?.position ?? snapshot.car.pose.position,
      rotation: w?.rotation ?? snapshot.car.pose.rotation,
      steerRad: w?.steerRad ?? 0,
      spinRad: w?.spinRad ?? 0,
      inContact: w?.inContact ?? false,
    };
  });

  const sensorBeams = extractRenderedBeams(snapshot);

  const obstacles: RenderedObstacleData[] = snapshot.obstacles.map((obs) => ({
    id: obs.id,
    type: obs.type,
    pose: obs.pose,
    yawDeg: quatToYawDeg(obs.pose.rotation),
    selected: obs.id === selectedObstacleId,
  }));

  return {
    trackMesh,
    carPose: snapshot.car.pose,
    wheels,
    sensorBeams,
    obstacles,
  };
}

/** Computes the camera position, target, and up vector for follow, orbit, and top-down modes. */
export function computeCameraTransform(
  mode: CameraMode,
  carPose: Pose,
  trackMesh: GeneratedTrackMeshData,
  orbit: OrbitCameraState = DEFAULT_ORBIT_CAMERA,
): CameraTransform {
  if (mode === 'follow') {
    // Car forward is -Z in chassis frame; camera sits behind (+Z) and above (+Y) the car.
    const behindOffset = rotateVec3ByQuat(carPose.rotation, [0, 1.35, 2.4]);
    const lookAheadOffset = rotateVec3ByQuat(carPose.rotation, [0, 0.15, -1.2]);
    return {
      position: [
        carPose.position[0] + behindOffset[0],
        carPose.position[1] + behindOffset[1],
        carPose.position[2] + behindOffset[2],
      ],
      target: [
        carPose.position[0] + lookAheadOffset[0],
        carPose.position[1] + lookAheadOffset[1],
        carPose.position[2] + lookAheadOffset[2],
      ],
      up: [0, 1, 0],
    };
  }

  const { centerX, centerZ, spanM } = trackMesh.bounds;
  if (mode === 'top-down') {
    const heightM = Math.max(spanM * 1.15, 11);
    return {
      position: [centerX, heightM, centerZ],
      target: [centerX, 0, centerZ],
      // In top-down view, -Z (car forward at yaw 0) points up on screen
      up: [0, 0, -1],
    };
  }

  // Orbit camera around track centre
  const elev = Math.max(0.15, Math.min(Math.PI / 2 - 0.05, orbit.elevationRad));
  const dist = Math.max(2, orbit.distanceM);
  const horiz = dist * Math.cos(elev);
  return {
    position: [
      centerX + horiz * Math.sin(orbit.azimuthRad),
      dist * Math.sin(elev),
      centerZ + horiz * Math.cos(orbit.azimuthRad),
    ],
    target: [centerX, 0, centerZ],
    up: [0, 1, 0],
  };
}

function buildPerspectiveCamera(
  aspect: number,
  cameraTransform: CameraTransform,
  fovDeg = 48,
): THREE.PerspectiveCamera {
  const safeAspect = Number.isFinite(aspect) && aspect > 0 ? aspect : 16 / 9;
  const camera = new THREE.PerspectiveCamera(fovDeg, safeAspect, 0.05, 500);
  camera.position.set(...cameraTransform.position);
  camera.up.set(...cameraTransform.up);
  camera.lookAt(...cameraTransform.target);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld(true);
  return camera;
}

/**
 * Raycasts a 2D viewport screen coordinate `(clientX, clientY)` onto the `Y = 0` ground plane
 * using Three.js math (`THREE.PerspectiveCamera` + `THREE.Raycaster` + `THREE.Plane`).
 * If a live Three.js `camera` is provided, projects directly through that camera.
 */
export function screenToGroundPoint(
  clientX: number,
  clientY: number,
  rect: {
    readonly left: number;
    readonly top: number;
    readonly width: number;
    readonly height: number;
  },
  cameraTransform: CameraTransform,
  fovDeg = 48,
  liveCamera?: THREE.Camera | null,
): { readonly x: number; readonly z: number } | null {
  const width = rect.width > 0 ? rect.width : 800;
  const height = rect.height > 0 ? rect.height : 600;
  const ndcX = ((clientX - rect.left) / width) * 2 - 1;
  const ndcY = -((clientY - rect.top) / height) * 2 + 1;

  const camera = liveCamera ?? buildPerspectiveCamera(width / height, cameraTransform, fovDeg);
  if (liveCamera && 'aspect' in liveCamera) {
    const persp = liveCamera as THREE.PerspectiveCamera;
    const expectedAspect = width / height;
    if (Math.abs(persp.aspect - expectedAspect) > 1e-4) {
      persp.aspect = expectedAspect;
      persp.updateProjectionMatrix();
    }
    persp.updateMatrixWorld(true);
  }

  const raycaster = new THREE.Raycaster();
  raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), camera);

  const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const intersection = new THREE.Vector3();
  const hit = raycaster.ray.intersectPlane(groundPlane, intersection);
  if (!hit) return null;

  return {
    x: Math.round(hit.x * 1000) / 1000,
    z: Math.round(hit.z * 1000) / 1000,
  };
}

/**
 * Projects a ground point `(x, z)` (`y = 0`) to normalized `[0..1, 0..1]` viewport coordinates
 * for interactive overlay markers and testing.
 * If a live Three.js `camera` is provided, projects directly through that camera.
 */
export function groundPointToViewportUV(
  point: { readonly x: number; readonly z: number },
  aspect: number,
  cameraTransform: CameraTransform,
  fovDeg = 48,
  liveCamera?: THREE.Camera | null,
): { readonly u: number; readonly v: number } {
  const safeAspect = Number.isFinite(aspect) && aspect > 0 ? aspect : 16 / 9;
  const camera = liveCamera ?? buildPerspectiveCamera(safeAspect, cameraTransform, fovDeg);
  if (liveCamera && 'aspect' in liveCamera) {
    const persp = liveCamera as THREE.PerspectiveCamera;
    if (Math.abs(persp.aspect - safeAspect) > 1e-4) {
      persp.aspect = safeAspect;
      persp.updateProjectionMatrix();
    }
    persp.updateMatrixWorld(true);
  }

  const projected = new THREE.Vector3(point.x, 0, point.z).project(camera);
  return {
    u: (projected.x + 1) * 0.5,
    v: (-projected.y + 1) * 0.5,
  };
}
