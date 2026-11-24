import type { CreateActuatorModel } from '../api/actuators.ts';
import type { CreateSensorModel } from '../api/sensors.ts';
import type { PhysicsStage } from '../api/vehicle.ts';
import { createActuatorModel, createStageTwoActuatorModel } from '../actuators/index.ts';
import { createSensorModel, createStageTwoSensorModel, type LivePack } from '../sensors/index.ts';

/**
 * The model factories a Run uses unless the caller overrides them, for the
 * selected physics stage. `pack` is the vehicle's battery.
 */
export function defaultModels(
  stage: PhysicsStage,
  pack: LivePack,
): { actuator: CreateActuatorModel; sensor: CreateSensorModel } {
  return stage === 2
    ? { actuator: createStageTwoActuatorModel, sensor: createStageTwoSensorModel(pack) }
    : { actuator: createActuatorModel, sensor: createSensorModel };
}
