/** Which way an ESC's throttle signal pushes, past its deadband. */
export type ThrottleDirection = 'forward' | 'back' | 'neutral';

/** What the ESC does with the motor for a push. */
export type DriveAction = 'drive' | 'brake' | 'coast';

/** The part of an armed ESC that decides what a push forward or back means. */
export interface Gearbox {
  /** The signal as it stands at `nowUs`; called whenever the signal or the time changes. */
  observe(direction: ThrottleDirection, nowUs: number, periodUs: number): void;
  action(direction: 'forward' | 'back'): DriveAction;
  /** The signal was lost. */
  reset(): void;
}

/** Physics stage 1: forward drives forward, back drives in reverse if the part can. */
export function directGearbox(reverse: boolean): Gearbox {
  return {
    observe: () => undefined,
    action: (direction) => (direction === 'forward' || reverse ? 'drive' : 'coast'),
    reset: () => undefined,
  };
}

/**
 * Forward / brake / reverse, as on a hobby ESC (physics stage 2).
 *
 * - The first push back brakes, however long it is held.
 * - Neutral for at least one PWM frame, then a second push back, reverses.
 *   After that, neutral and back again stays in reverse.
 * - Any forward push starts over: the next push back brakes.
 * - With reverse disabled, every push back brakes.
 *
 * It has no motor-speed feedback: the second push reverses even if the car is
 * still rolling forward (docs/PHYSICS.md).
 */
export function doubleTapGearbox(reverse: boolean): Gearbox {
  /** `forward`: the next push back brakes. `released`: braked, and back in neutral. */
  let state: 'forward' | 'braking' | 'released' | 'reversing' = 'forward';
  let neutralSinceUs: number | undefined;

  return {
    observe(direction, nowUs, periodUs): void {
      if (direction !== 'neutral') {
        neutralSinceUs = undefined;
        if (direction === 'forward') state = 'forward';
        else if (state === 'forward') state = 'braking';
        else if (state === 'released') state = reverse ? 'reversing' : 'braking';
        return;
      }
      if (state === 'forward' || state === 'released') return;
      neutralSinceUs ??= nowUs;
      if (nowUs - neutralSinceUs >= periodUs) state = 'released';
    },
    action(direction): DriveAction {
      if (direction === 'forward') return 'drive';
      return state === 'reversing' ? 'drive' : 'brake';
    },
    reset(): void {
      state = 'forward';
      neutralSinceUs = undefined;
    },
  };
}
