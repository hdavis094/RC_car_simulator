import type { PartContext } from '../api/parts.ts';
import type { VehicleState } from '../api/vehicle.ts';
import type { Quat, Vec3 } from '../api/math.ts';
import { quatMul, quatX, quatY, rotate } from '../world/quat.ts';
import { mountOf } from '../vehicle/mount.ts';

export interface SensorTransform {
  readonly position: Vec3;
  readonly rotation: Quat;
}

/** World pose of a sensor part from the vehicle state (mirrors Vehicle.chassisToWorld). */
export function sensorTransform(part: PartContext, vehicle: VehicleState): SensorTransform {
  const { positionMm, yawDeg, pitchDeg } = mountOf(
    part.chassis,
    part.instance.placement,
    part.instance.instanceId,
  );
  const yawRad = (yawDeg * Math.PI) / 180;
  const pitchRad = (pitchDeg * Math.PI) / 180;
  const pose = vehicle.pose;
  const [x, y, z] = positionMm;
  const o = rotate(pose.rotation, [x / 1000, y / 1000, z / 1000]);
  return {
    position: [pose.position[0] + o[0], pose.position[1] + o[1], pose.position[2] + o[2]],
    rotation: quatMul(quatMul(pose.rotation, quatY(yawRad)), quatX(pitchRad)),
  };
}

export function worldToBody(q: Quat, v: Vec3): Vec3 {
  const conj: Quat = [-q[0], -q[1], -q[2], q[3]];
  return rotate(conj, v);
}
