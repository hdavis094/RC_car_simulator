import type { BehaviorTemplate } from '@rcsim/schema';
import type { PartContext } from './parts.ts';

/** A PWM output as the firmware drives it. `periodUs` 0 means stopped. */
export interface PwmSignal {
  readonly periodUs: number;
  readonly pulseUs: number;
}

/** What one actuator contributes to the vehicle command. */
export type ActuatorOutput =
  | {
      readonly kind: 'steering';
      /**
       * Front-wheel angle, radians, positive left. From the servo's output
       * angle θ (degrees, positive above neutral, slew-limited) and the chassis:
       * `−θ × steeringLinkageRatio × π/180`, clamped to ±maxSteeringAngleDeg.
       */
      readonly steerAngleRad: number;
    }
  | {
      readonly kind: 'drive';
      /** −1..1, after arming, deadband and throttle curve. */
      readonly motorDuty: number;
    };

/**
 * Turns a part's PWM input into a physical command, modelling the part:
 * servo travel and slew rate; ESC arming, deadband and throttle curve.
 * One instance per actuator part, created per run.
 */
export interface ActuatorModel {
  readonly instanceId: string;
  readonly template: BehaviorTemplate;
  /** The GPIO whose PWM drives this part. */
  readonly gpio: number;
  /** A new PWM value from the firmware, effective at `tUs`. */
  setPwm(signal: PwmSignal, tUs: number): void;
  /** Advances the model to `nowUs` (slew, arming timers) and returns its output. */
  update(nowUs: number): ActuatorOutput;
}

/** Builds the model for an actuator part (`servo`, `esc-motor`). Implemented by P1-A. */
export type CreateActuatorModel = (part: PartContext) => ActuatorModel;
