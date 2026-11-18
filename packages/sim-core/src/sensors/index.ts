import type { CreateSensorModel } from '../api/sensors.ts';
import type { PartContext } from '../api/parts.ts';
import { createDistanceSensorModel } from './distance.ts';
import { createImuSensorModel } from './imu.ts';
import { createVoltageSensorModel } from './voltage.ts';

export { createDistanceSensorModel } from './distance.ts';
export { createImuSensorModel } from './imu.ts';
export { createVoltageSensorModel } from './voltage.ts';

export const createSensorModel: CreateSensorModel = (part: PartContext) => {
  const definition = part.definition;
  if (!('behavior' in definition)) {
    throw new Error(`${part.instance.instanceId} has no behavior`);
  }
  const behavior = definition.behavior;
  switch (behavior.template) {
    case 'distance-raycast':
      return createDistanceSensorModel(part);
    case 'imu':
      return createImuSensorModel(part);
    case 'voltage-divider':
      return createVoltageSensorModel(part);
    default:
      throw new Error(`${part.instance.instanceId} (${behavior.template}) is not a sensor`);
  }
};
