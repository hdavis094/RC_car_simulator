import type { SimClock } from '../clock.ts';

/** A plain SimClock. */
export class FakeClock implements SimClock {
  readonly tickUs: number;
  #tick = 0;

  constructor(tickUs = 1000) {
    this.tickUs = tickUs;
  }

  get tick(): number {
    return this.#tick;
  }

  get nowUs(): number {
    return this.#tick * this.tickUs;
  }

  advance(): void {
    this.#tick += 1;
  }
}
