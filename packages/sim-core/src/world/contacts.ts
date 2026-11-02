/**
 * How long contact with a target must have been broken for a new touch to be
 * a new collision. Measured over 270 coast-in impacts (walls, cones, boxes
 * and barriers, 0-85° to the face, 0.3-1.0 duty): the suspension's bounce
 * re-touches within 5-7 ms. Gaps of 7 ms or more give one event per hit in
 * every case; 5 ms and less leave one hit counted twice. 10 ms is that
 * smallest working value with a little margin. A real second hit, driving
 * back into the wall, takes far longer.
 */
export const BOUNCE_GAP_US = 10_000;

/**
 * Turns Rapier's start/stop contact events into collision events: one when
 * the car first touches a target, none while it stays in contact (including
 * sliding along a wall made of many colliders), and none for a bounce that
 * re-touches within `minGapUs` of letting go. A target is an obstacle or one
 * edge of the track: the car can hit the opposite edge straight after.
 */
export class ContactTracker {
  readonly #minGapUs: number;
  readonly #targets = new Map<string, { active: number; releasedAtUs: number | undefined }>();

  constructor(minGapUs = BOUNCE_GAP_US) {
    this.#minGapUs = minGapUs;
  }

  /** A contact with `key` began at `nowUs`. True if it counts as a new collision. */
  started(key: string, nowUs: number): boolean {
    let state = this.#targets.get(key);
    if (!state) {
      state = { active: 0, releasedAtUs: undefined };
      this.#targets.set(key, state);
    }
    const fresh =
      state.active === 0 &&
      (state.releasedAtUs === undefined || nowUs - state.releasedAtUs >= this.#minGapUs);
    state.active += 1;
    return fresh;
  }

  /** A contact with `key` ended at `nowUs`. */
  stopped(key: string, nowUs: number): void {
    const state = this.#targets.get(key);
    if (!state || state.active === 0) return;
    state.active -= 1;
    if (state.active === 0) state.releasedAtUs = nowUs;
  }

  /** Forgets a target (it was removed from the world). */
  forget(key: string): void {
    this.#targets.delete(key);
  }
}
