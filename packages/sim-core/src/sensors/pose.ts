import type { PartContext } from '../api/parts.ts';
import type { VehicleState } from '../api/vehicle.ts';
import type { Quat, Vec3 } from '../api/math.ts';
import { quatMul, quatX, quatY, rotate } from '../world/quat.ts';

export interface SensorTransform {
  readonly position: Vec3;
  readonly rotation: Quat;
}

/** Resolves a part's mount point + placement into a chassis-frame offset and yaw/pitch. */
function mountOf(part: PartContext): { offsetM: Vec3; yawRad: number; pitchRad: number } {
  const placement = part.instance.placement;
  const mount =
    part.chassis.mountPoints.find((m) => m.id === placement?.mount) ?? part.chassis.mountPoints[0];
  if (!mount) throw new Error(`${part.instance.instanceId} has no mount point`);
  const offsetMm = {
    x: mount.positionMm.x + (placement?.offsetMm?.x ?? 0),
    y: mount.positionMm.y + (placement?.offsetMm?.y ?? 0),
    z: mount.positionMm.z + (placement?.offsetMm?.z ?? 0),
  };
  const yawDeg = mount.yawDeg + (placement?.yawDeg ?? 0);
  const pitchDeg = mount.pitchDeg + (placement?.pitchDeg ?? 0);
  return {
    offsetM: [offsetMm.x / 1000, offsetMm.y / 1000, offsetMm.z / 1000],
    yawRad: (yawDeg * Math.PI) / 180,
    pitchRad: (pitchDeg * Math.PI) / 180,
  };
}

/** World pose of a sensor part from the vehicle state (mirrors Vehicle.chassisToWorld). */
export function sensorTransform(part: PartContext, vehicle: VehicleState): SensorTransform {
  const { offsetM, yawRad, pitchRad } = mountOf(part);
  const pose = vehicle.pose;
  const o = rotate(pose.rotation, offsetM);
  return {
    position: [pose.position[0] + o[0], pose.position[1] + o[1], pose.position[2] + o[2]],
    rotation: quatMul(quatMul(pose.rotation, quatY(yawRad)), quatX(pitchRad)),
  };
}

export function worldToBody(q: Quat, v: Vec3): Vec3 {
  const conj: Quat = [-q[0], -q[1], -q[2], q[3]];
  return rotate(conj, v);
}
