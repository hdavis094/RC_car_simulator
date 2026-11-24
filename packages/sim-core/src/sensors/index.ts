import type { CreateSensorModel } from '../api/sensors.ts';
import type { PartContext } from '../api/parts.ts';
import { createDistanceSensorModel } from './distance.ts';
import { createImuSensorModel } from './imu.ts';
import { createVoltageSensorModel, type LivePack } from './voltage.ts';

export { createDistanceSensorModel } from './distance.ts';
export { createImuSensorModel } from './imu.ts';
export { createVoltageSensorModel, type LivePack } from './voltage.ts';

const sensorModel = (part: PartContext, pack?: LivePack) => {
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
      return createVoltageSensorModel(part, pack);
    default:
      throw new Error(`${part.instance.instanceId} (${behavior.template}) is not a sensor`);
  }
};

/** Builds the model for a sensor part (physics stage 1). */
export const createSensorModel: CreateSensorModel = (part) => sensorModel(part);

/** The same for physics stage 2, where a voltage divider reads the sagging pack. */
export const createStageTwoSensorModel =
  (pack: LivePack): CreateSensorModel =>
  (part) =>
    sensorModel(part, pack);
