import type { SimClock } from '../api/clock.ts';

/** The run's clock: integer µs, advanced one tick at a time by the Run. */
export class TickClock implements SimClock {
  readonly tickUs: number;
  #tick = 0;

  constructor(tickUs = 1000) {
    if (!Number.isInteger(tickUs) || tickUs <= 0) {
      throw new Error(`tickUs must be a positive integer, got ${tickUs}`);
    }
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
