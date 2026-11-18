import type { CreateSensorModel } from '../api/sensors.ts';
import { createActuatorModel } from '../actuators/index.ts';
import { createSensorModel as createRealSensorModel } from '../sensors/index.ts';

/**
 * The model factories a Run uses unless the caller overrides them.
 */
export const defaultActuatorModel = createActuatorModel;
export const defaultSensorModel: CreateSensorModel = (part) => createRealSensorModel(part);
