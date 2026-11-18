import { carParts, type ChassisDefinition } from '@rcsim/schema';
import type { Vec3 } from '../api/math.ts';
import type { VehicleSpec } from '../api/vehicle.ts';

/** The drive motor, from the car's `esc-motor` part. */
export interface MotorParams {
  /** Unloaded speed constant, rad/s per volt. */
  readonly kvRadPerSV: number;
  /** Stall torque at the nominal battery voltage, N·m. */
  readonly stallTorqueNm: number;
}

/** Everything the physics needs, in SI, derived from `car.json` and the catalog. */
export interface VehicleParams {
  readonly massKg: number;
  /** Centre of gravity in the chassis frame (origin on the ground between the axles), metres. */
  readonly cogM: Vec3;
  readonly wheelbaseM: number;
  readonly trackWidthM: number;
  readonly wheelRadiusM: number;
  readonly maxSteerRad: number;
  readonly driveWheels: ChassisDefinition['driveWheels'];
  /** Motor turns per wheel turn. */
  readonly finalDriveRatio: number;
  /** Overall body box (width, height, length), metres. */
  readonly bodyM: { readonly width: number; readonly height: number; readonly length: number };
  /** Null when the car has no drive motor: it can steer but not move itself. */
  readonly motor: MotorParams | null;
  /** Nominal pack voltage, volts. */
  readonly batteryV: number;
}

/** Pack voltage when the car has no battery part (2S LiPo). */
const DEFAULT_BATTERY_V = 7.4;
const MM = 0.001;

export function vehicleParams(spec: VehicleSpec): VehicleParams {
  const { car, catalog } = spec;
  const chassis = catalog.get(car.chassis.partId);
  if (chassis?.category !== 'chassis') {
    throw new Error(`car chassis "${car.chassis.partId}" is not a chassis part`);
  }

  // The chassis' own mass excludes the parts fitted to it (the catalog notes
  // say so), so the car weighs the chassis plus every part. The centre of
  // gravity is the chassis': stage 1 does not place the parts' masses.
  let massG = chassis.massG;
  let motor: MotorParams | null = null;
  let batteryV = DEFAULT_BATTERY_V;
  let hasBattery = false;
  for (const instance of carParts(car)) {
    const definition = catalog.get(instance.partId);
    if (!definition) continue;
    massG += definition.massG;
    if (!('behavior' in definition)) continue;
    const behavior = definition.behavior;
    if (behavior.template === 'esc-motor' && motor === null) {
      motor = {
        kvRadPerSV: (behavior.params.kvRpmPerV * 2 * Math.PI) / 60,
        stallTorqueNm: behavior.params.maxTorqueNm,
      };
    } else if (behavior.template === 'battery' && !hasBattery) {
      hasBattery = true;
      batteryV = behavior.params.cells * behavior.params.cellNominalV;
    }
  }

  return {
    massKg: Math.max(massG, 1) / 1000,
    cogM: [
      chassis.centreOfGravityMm.x * MM,
      chassis.centreOfGravityMm.y * MM,
      chassis.centreOfGravityMm.z * MM,
    ],
    wheelbaseM: chassis.wheelbaseMm * MM,
    trackWidthM: chassis.trackWidthMm * MM,
    wheelRadiusM: chassis.wheelRadiusMm * MM,
    maxSteerRad: (chassis.maxSteeringAngleDeg * Math.PI) / 180,
    driveWheels: chassis.driveWheels,
    finalDriveRatio: chassis.finalDriveRatio,
    bodyM: {
      width: chassis.dimensionsMm.width * MM,
      height: chassis.dimensionsMm.height * MM,
      length: chassis.dimensionsMm.length * MM,
    },
    motor,
    batteryV,
  };
}
