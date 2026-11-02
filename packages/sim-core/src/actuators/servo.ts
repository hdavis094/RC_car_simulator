import type { ServoParams } from '@rcsim/schema';
import type { ActuatorModel, ActuatorOutput, PwmSignal } from '../api/actuators.ts';
import type { PartContext } from '../api/parts.ts';

const DEG = Math.PI / 180;

/**
 * A steering servo. The pulse width sets a target angle (linear across the
 * pulse range, positive above neutral); the output arm moves toward it no
 * faster than the servo's slew rate. A pulse that differs from the last one
 * the servo accepted by no more than its deadband is ignored. With no signal
 * the servo holds where it is.
 */
export function createServoModel(
  part: PartContext,
  params: ServoParams,
  gpio: number,
): ActuatorModel {
  const { chassis } = part;
  const maxSteerRad = chassis.maxSteeringAngleDeg * DEG;
  let acceptedUs = params.pulseNeutralUs;
  let targetDeg = 0;
  let angleDeg = 0;
  let lastUs = 0;

  return {
    instanceId: part.instance.instanceId,
    template: 'servo',
    gpio,
    setPwm(signal: PwmSignal): void {
      if (signal.periodUs <= 0) return; // no pulses: the arm stays put
      if (Math.abs(signal.pulseUs - acceptedUs) <= params.deadbandUs) return;
      acceptedUs = signal.pulseUs;
      const pulse = Math.max(params.pulseMinUs, Math.min(params.pulseMaxUs, signal.pulseUs));
      targetDeg =
        ((pulse - params.pulseNeutralUs) / (params.pulseMaxUs - params.pulseMinUs)) *
        params.travelDeg;
    },
    update(nowUs: number): ActuatorOutput {
      const dtS = Math.max(0, nowUs - lastUs) / 1_000_000;
      lastUs = nowUs;
      const step = params.slewDegPerS * dtS;
      angleDeg += Math.max(-step, Math.min(step, targetDeg - angleDeg));
      // Servo angle above neutral steers right with a positive linkage ratio (README → Signs).
      const steerRad = -angleDeg * chassis.steeringLinkageRatio * DEG;
      return {
        kind: 'steering',
        steerAngleRad: Math.max(-maxSteerRad, Math.min(maxSteerRad, steerRad)),
      };
    },
  };
}
