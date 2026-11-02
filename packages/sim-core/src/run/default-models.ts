import { createFakeSensorModel } from '../api/stubs/fake-models.ts';
import type { CreateSensorModel } from '../api/sensors.ts';
import { createActuatorModel } from '../actuators/index.ts';

/**
 * The model factories a Run uses unless the caller overrides them. Actuators
 * are P1-A's. Sensors are the API's constant-reading fake until P1-B's
 * `sensors/` merges; swapping the import below is the only change needed.
 */
export const defaultActuatorModel = createActuatorModel;
export const defaultSensorModel: CreateSensorModel = (part) => createFakeSensorModel(part);
