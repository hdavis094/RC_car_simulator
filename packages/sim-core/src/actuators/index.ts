import type { CreateActuatorModel } from '../api/actuators.ts';
import type { PhysicsStage } from '../api/vehicle.ts';
import { createEscModel } from './esc.ts';
import { doubleTapGearbox } from './gearbox.ts';
import { createServoModel } from './servo.ts';

export { createEscModel, throttleCurve } from './esc.ts';
export { createServoModel } from './servo.ts';

const actuatorFactory =
  (stage: PhysicsStage): CreateActuatorModel =>
  (part) => {
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
        return createEscModel(
          part,
          behavior.params,
          gpio,
          stage === 2 ? doubleTapGearbox(behavior.params.reverse) : undefined,
        );
      default:
        throw new Error(`${part.instance.instanceId} (${behavior.template}) is not an actuator`);
    }
  };

/** Builds the model for an actuator part: `servo` or `esc-motor` (physics stage 1). */
export const createActuatorModel: CreateActuatorModel = actuatorFactory(1);

/** The same for physics stage 2, where the ESC brakes before it reverses. */
export const createStageTwoActuatorModel: CreateActuatorModel = actuatorFactory(2);
