import { carParts, type ChassisDefinition } from '@rcsim/schema';
import type { Vec3 } from '../api/math.ts';
import type { PhysicsStage, VehicleSpec } from '../api/vehicle.ts';
import { boxInertia, massProperties, type MassProperties, type PointMass } from './mass.ts';
import { mountOf } from './mount.ts';

/** The drive motor, from the car's `esc-motor` part. */
export interface MotorParams {
  /** Unloaded speed constant, rad/s per volt. */
  readonly kvRadPerSV: number;
  /** Stall torque at the nominal battery voltage, N·m. */
  readonly stallTorqueNm: number;
  /** The battery voltage that torque is quoted at, volts. */
  readonly nominalV: number;
}

/** Everything the physics needs, in SI, derived from `car.json` and the catalog. */
export interface VehicleParams {
  readonly physicsStage: PhysicsStage;
  readonly massKg: number;
  /** Centre of gravity in the chassis frame (origin on the ground between the axles), metres. */
  readonly cogM: Vec3;
  /** Moments of inertia about the centre of gravity, along the chassis axes, kg·m². */
  readonly inertiaKgM2: MassProperties['inertiaKgM2'];
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
  /** Pack internal resistance, ohms: stage 2 sags the voltage by it. 0 with no battery. */
  readonly batteryResistanceOhm: number;
}

/** Pack voltage when the car has no battery part (2S LiPo). */
const DEFAULT_BATTERY_V = 7.4;
const MM = 0.001;

export function vehicleParams(spec: VehicleSpec): VehicleParams {
  const { car, catalog } = spec;
  const physicsStage = spec.physicsStage ?? 1;
  if (physicsStage !== 1 && physicsStage !== 2) {
    throw new Error(`unknown physics stage ${String(physicsStage)}: expected 1 or 2`);
  }
  const chassis = catalog.get(car.chassis.partId);
  if (chassis?.category !== 'chassis') {
    throw new Error(`car chassis "${car.chassis.partId}" is not a chassis part`);
  }

  // The chassis' own mass excludes the parts fitted to it (the catalog notes
  // say so), so the car weighs the chassis plus every part. Stage 1 keeps the
  // centre of gravity at the chassis'; stage 2 places the parts' masses.
  let massG = chassis.massG;
  let motor: Omit<MotorParams, 'nominalV'> | null = null;
  let batteryV = DEFAULT_BATTERY_V;
  let batteryResistanceOhm = 0;
  let hasBattery = false;
  const placed: PointMass[] = [];
  for (const instance of carParts(car)) {
    const definition = catalog.get(instance.partId);
    if (!definition) continue;
    massG += definition.massG;
    if (instance.placement) {
      const [x, y, z] = mountOf(chassis, instance.placement, instance.instanceId).positionMm;
      placed.push({ massKg: definition.massG / 1000, atM: [x * MM, y * MM, z * MM] });
    }
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
      batteryResistanceOhm = behavior.params.internalResistanceMohm / 1000;
    }
  }

  const massKg = Math.max(massG, 1) / 1000;
  const chassisCogM: Vec3 = [
    chassis.centreOfGravityMm.x * MM,
    chassis.centreOfGravityMm.y * MM,
    chassis.centreOfGravityMm.z * MM,
  ];
  const bodyM = {
    width: chassis.dimensionsMm.width * MM,
    height: chassis.dimensionsMm.height * MM,
    length: chassis.dimensionsMm.length * MM,
  };
  const bodyKg = massKg - placed.reduce((sum, p) => sum + p.massKg, 0);
  const mass: MassProperties =
    physicsStage === 2
      ? massProperties({ massKg: bodyKg, atM: chassisCogM }, placed, bodyM)
      : { cogM: chassisCogM, inertiaKgM2: boxInertia(massKg, bodyM) };

  return {
    physicsStage,
    massKg,
    ...mass,
    wheelbaseM: chassis.wheelbaseMm * MM,
    trackWidthM: chassis.trackWidthMm * MM,
    wheelRadiusM: chassis.wheelRadiusMm * MM,
    maxSteerRad: (chassis.maxSteeringAngleDeg * Math.PI) / 180,
    driveWheels: chassis.driveWheels,
    finalDriveRatio: chassis.finalDriveRatio,
    bodyM,
    // The stall torque is quoted at the nominal pack voltage.
    motor: motor === null ? null : { ...motor, nominalV: batteryV },
    batteryV,
    batteryResistanceOhm,
  };
}
