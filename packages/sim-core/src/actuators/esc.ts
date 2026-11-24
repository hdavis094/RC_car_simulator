import type { EscMotorParams } from '@rcsim/schema';
import type { ActuatorModel, ActuatorOutput, PwmSignal } from '../api/actuators.ts';
import type { PartContext } from '../api/parts.ts';
import type { DriveOutput } from '../vehicle/command.ts';
import { directGearbox, type Gearbox, type ThrottleDirection } from './gearbox.ts';

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
 * A brushed ESC.
 *
 * - **Arming.** No output until the signal has sat in the neutral band for
 *   `armingMs` without a break. A throttle pulse before that restarts the
 *   wait, as on the real controller. Losing the signal disarms.
 * - **Deadband.** Pulses within `deadbandUs` of neutral give zero output; the
 *   range outside it maps to 0..1 from the band's edge, so there is no jump.
 * - **Throttle curve.** The command magnitude goes through the part's curve.
 * - **Gearbox.** What a push forward or back does once armed. Physics stage 1
 *   uses `directGearbox` (back drives in reverse, no braking); stage 2 passes
 *   `doubleTapGearbox`.
 */
export function createEscModel(
  part: PartContext,
  params: EscMotorParams,
  gpio: number,
  gearbox: Gearbox = directGearbox(params.reverse),
): ActuatorModel {
  const armingUs = params.armingMs * 1000;
  let running = false;
  let periodUs = 0;
  let pulseUs = params.pulseNeutralUs;
  let neutralSinceUs: number | undefined;
  let armed = false;
  let nowUs = 0;

  /** Which way the signal pushes: forward, back, or neutral (within the deadband). */
  const direction = (): ThrottleDirection => {
    const offset = pulseUs - params.pulseNeutralUs;
    if (Math.abs(offset) <= params.deadbandUs) return 'neutral';
    return offset > 0 ? 'forward' : 'back';
  };

  /** Re-evaluates arming and the gearbox after the signal or the time changed. */
  const track = (): void => {
    if (!running) {
      armed = false;
      neutralSinceUs = undefined;
      gearbox.reset();
      return;
    }
    if (armed) {
      gearbox.observe(direction(), nowUs, periodUs);
      return;
    }
    if (direction() !== 'neutral') {
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
      periodUs = signal.periodUs;
      pulseUs = signal.pulseUs;
      track();
    },
    update(t: number): ActuatorOutput {
      nowUs = t;
      track();
      if (!armed || !running) return { kind: 'drive', motorDuty: 0 };
      const way = direction();
      const action = way === 'neutral' ? 'coast' : gearbox.action(way);
      if (action === 'coast') return { kind: 'drive', motorDuty: 0 };
      const offset = pulseUs - params.pulseNeutralUs;
      const span =
        (way === 'forward'
          ? params.pulseMaxUs - params.pulseNeutralUs
          : params.pulseNeutralUs - params.pulseMinUs) - params.deadbandUs;
      const input = span > 0 ? (Math.abs(offset) - params.deadbandUs) / span : 1;
      const duty = throttleCurve(params.throttleCurve, input);
      const output: DriveOutput = {
        kind: 'drive',
        motorDuty: way === 'forward' ? duty : -duty,
        ...(action === 'brake' ? { brake: true } : {}),
      };
      return output;
    },
  };
}
