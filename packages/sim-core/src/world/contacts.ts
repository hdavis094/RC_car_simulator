/**
 * Turns Rapier's start/stop contact events into collision events: one when
 * the car first touches a target, none while it stays in contact (including
 * sliding along a wall made of many colliders), and none for a bounce that
 * re-touches within `minGapUs` of letting go.
 */
export class ContactTracker {
  readonly #minGapUs: number;
  readonly #targets = new Map<string, { active: number; releasedAtUs: number | undefined }>();

  constructor(minGapUs = 250_000) {
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
