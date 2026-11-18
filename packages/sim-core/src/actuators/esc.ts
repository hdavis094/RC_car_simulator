import type { EscMotorParams } from '@rcsim/schema';
import type { ActuatorModel, ActuatorOutput, PwmSignal } from '../api/actuators.ts';
import type { PartContext } from '../api/parts.ts';

/** Piecewise-linear map through the curve's points; `input` in 0..1. */
export function throttleCurve(points: EscMotorParams['throttleCurve'], input: number): number {
  const x = Math.max(0, Math.min(1, input));
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    if (a && b && x <= b.input) {
      return a.output + ((b.output - a.output) * (x - a.input)) / (b.input - a.input);
    }
  }
  return points[points.length - 1]?.output ?? x;
}

/**
 * A brushed ESC (physics stage 1).
 *
 * - **Arming.** No output until the signal has sat in the neutral band for
 *   `armingMs` without a break. A throttle pulse before that restarts the
 *   wait, as on the real controller. Losing the signal disarms.
 * - **Deadband.** Pulses within `deadbandUs` of neutral give zero output; the
 *   range outside it maps to 0..1 from the band's edge, so there is no jump.
 * - **Throttle curve.** The command magnitude goes through the part's curve.
 * - **Reverse.** Pulses below neutral drive in reverse (also the brake) when
 *   the part allows it. There is no brake/double-tap logic yet (stage 2).
 */
export function createEscModel(
  part: PartContext,
  params: EscMotorParams,
  gpio: number,
): ActuatorModel {
  const armingUs = params.armingMs * 1000;
  let running = false;
  let pulseUs = params.pulseNeutralUs;
  let neutralSinceUs: number | undefined;
  let armed = false;
  let nowUs = 0;

  const isNeutral = (): boolean =>
    running && Math.abs(pulseUs - params.pulseNeutralUs) <= params.deadbandUs;

  /** Re-evaluates arming after the signal or the time changed. */
  const track = (): void => {
    if (!running) {
      armed = false;
      neutralSinceUs = undefined;
      return;
    }
    if (armed) return;
    if (!isNeutral()) {
      neutralSinceUs = undefined;
      return;
    }
    neutralSinceUs ??= nowUs;
    if (nowUs - neutralSinceUs >= armingUs) armed = true;
  };

  return {
    instanceId: part.instance.instanceId,
    template: 'esc-motor',
    gpio,
    setPwm(signal: PwmSignal, tUs: number): void {
      // Credit the time the old signal held up to now before it changes.
      nowUs = tUs;
      track();
      running = signal.periodUs > 0;
      pulseUs = signal.pulseUs;
      track();
    },
    update(t: number): ActuatorOutput {
      nowUs = t;
      track();
      if (!armed || !running) return { kind: 'drive', motorDuty: 0 };
      const offset = pulseUs - params.pulseNeutralUs;
      if (Math.abs(offset) <= params.deadbandUs) return { kind: 'drive', motorDuty: 0 };
      const forward = offset > 0;
      if (!forward && !params.reverse) return { kind: 'drive', motorDuty: 0 };
      const span =
        (forward
          ? params.pulseMaxUs - params.pulseNeutralUs
          : params.pulseNeutralUs - params.pulseMinUs) - params.deadbandUs;
      const input = span > 0 ? (Math.abs(offset) - params.deadbandUs) / span : 1;
      const duty = throttleCurve(params.throttleCurve, input);
      return { kind: 'drive', motorDuty: forward ? duty : -duty };
    },
  };
}
