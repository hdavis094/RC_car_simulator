import type { ActuatorModel, ActuatorOutput, PwmSignal } from '../actuators.ts';
import type { PartContext } from '../parts.ts';
import type { SensorBeam, SensorContext, SensorModel, SensorReading } from '../sensors.ts';

/**
 * Linear, instant actuator models: a servo maps pulse to steering with no
 * slew; an ESC maps pulse to duty with no arming or deadband. Uses the
 * part's behavior params and the chassis linkage, with the contract's signs.
 */
export function createFakeActuatorModel(part: PartContext): ActuatorModel {
  const definition = part.definition;
  if (!('behavior' in definition)) throw new Error(`${part.instance.instanceId} has no behavior`);
  const behavior = definition.behavior;
  if (behavior.template !== 'servo' && behavior.template !== 'esc-motor') {
    throw new Error(`${part.instance.instanceId} (${behavior.template}) is not an actuator`);
  }
  const gpio = Object.values(part.gpioPins)[0];
  if (gpio === undefined) throw new Error(`${part.instance.instanceId} has no GPIO-wired pin`);
  let pulseUs = behavior.params.pulseNeutralUs;
  let running = false;

  return {
    instanceId: part.instance.instanceId,
    template: behavior.template,
    gpio,
    setPwm(signal: PwmSignal): void {
      running = signal.periodUs > 0;
      pulseUs = signal.pulseUs;
    },
    update(): ActuatorOutput {
      const p = behavior.params;
      const offset = running ? pulseUs - p.pulseNeutralUs : 0;
      if (behavior.template === 'servo') {
        const servoDeg =
          (offset / (behavior.params.pulseMaxUs - behavior.params.pulseMinUs)) *
          behavior.params.travelDeg;
        const max = (part.chassis.maxSteeringAngleDeg * Math.PI) / 180;
        const angle = (-servoDeg * part.chassis.steeringLinkageRatio * Math.PI) / 180;
        return { kind: 'steering', steerAngleRad: Math.max(-max, Math.min(max, angle)) };
      }
      const span = offset >= 0 ? p.pulseMaxUs - p.pulseNeutralUs : p.pulseNeutralUs - p.pulseMinUs;
      return { kind: 'drive', motorDuty: Math.max(-1, Math.min(1, offset / span)) };
    },
  };
}

/**
 * A sensor that reports a constant reading at its update rate: a fixed
 * distance for `distance-raycast`, gravity for `imu`, a fixed voltage
 * otherwise. Draws nothing from its Rng.
 */
export function createFakeSensorModel(
  part: PartContext,
  fixed: { mm?: number; volts?: number } = {},
): SensorModel {
  const definition = part.definition;
  if (!('behavior' in definition)) throw new Error(`${part.instance.instanceId} has no behavior`);
  const behavior = definition.behavior;
  const updateHz =
    behavior.template === 'distance-raycast' || behavior.template === 'imu'
      ? behavior.params.updateHz
      : 10;
  const periodUs = Math.round(1_000_000 / updateHz);
  let nextUs = 0;

  const reading = (tUs: number): SensorReading => {
    if (behavior.template === 'distance-raycast') {
      return { type: 'distance', tUs, mm: fixed.mm ?? 1000, status: 'valid' };
    }
    if (behavior.template === 'imu') {
      return { type: 'imu', tUs, accel: [0, 0, 9.81], gyro: [0, 0, 0], tempC: 25 };
    }
    return { type: 'analog', tUs, volts: fixed.volts ?? 2 };
  };

  return {
    instanceId: part.instance.instanceId,
    template: behavior.template,
    update(context: SensorContext): readonly SensorReading[] {
      // The HC-SR04's device kind has no readings: it answers with GPIO edges.
      if (definition.id.includes('hc-sr04')) return [];
      const out: SensorReading[] = [];
      while (nextUs < context.nowUs) {
        out.push(reading(nextUs));
        nextUs += periodUs;
      }
      return out;
    },
    beams(): readonly SensorBeam[] {
      return [];
    },
  };
}
