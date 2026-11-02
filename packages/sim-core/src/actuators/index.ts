import type { CreateActuatorModel } from '../api/actuators.ts';
import { createEscModel } from './esc.ts';
import { createServoModel } from './servo.ts';

export { createEscModel, throttleCurve } from './esc.ts';
export { createServoModel } from './servo.ts';

/** Builds the model for an actuator part: `servo` or `esc-motor`. */
export const createActuatorModel: CreateActuatorModel = (part) => {
  const definition = part.definition;
  if (!('behavior' in definition)) {
    throw new Error(`${part.instance.instanceId} has no behavior`);
  }
  const gpio = part.gpioPins['SIGNAL'] ?? Object.values(part.gpioPins)[0];
  if (gpio === undefined) {
    throw new Error(`${part.instance.instanceId} has no GPIO-wired signal pin`);
  }
  const behavior = definition.behavior;
  switch (behavior.template) {
    case 'servo':
      return createServoModel(part, behavior.params, gpio);
    case 'esc-motor':
      return createEscModel(part, behavior.params, gpio);
    default:
      throw new Error(`${part.instance.instanceId} (${behavior.template}) is not an actuator`);
  }
};
