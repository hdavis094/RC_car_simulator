import type { ChassisDefinition, Placement } from '@rcsim/schema';
import type { Vec3 } from '../api/math.ts';

/**
 * Where a placed part sits in the chassis frame: its mount point plus the
 * placement's offset and angles, in car.json's units (mm, degrees). An unknown
 * or missing mount id falls back to the chassis' first mount point.
 */
export function mountOf(
  chassis: ChassisDefinition,
  placement: Placement | undefined,
  instanceId: string,
): { positionMm: Vec3; yawDeg: number; pitchDeg: number } {
  const mount =
    chassis.mountPoints.find((m) => m.id === placement?.mount) ?? chassis.mountPoints[0];
  if (!mount) throw new Error(`${instanceId} has no mount point`);
  return {
    positionMm: [
      mount.positionMm.x + (placement?.offsetMm?.x ?? 0),
      mount.positionMm.y + (placement?.offsetMm?.y ?? 0),
      mount.positionMm.z + (placement?.offsetMm?.z ?? 0),
    ],
    yawDeg: mount.yawDeg + (placement?.yawDeg ?? 0),
    pitchDeg: mount.pitchDeg + (placement?.pitchDeg ?? 0),
  };
}
