import type { Rng, RngStreams } from '../clock.ts';

/** FNV-1a over UTF-16 code units: a stable 32-bit hash of a stream name. */
function hashName(name: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/** mulberry32: small, fast, integer-only, good enough for sensor noise. */
class Mulberry32 implements Rng {
  #state: number;
  #spare: number | undefined;

  constructor(seed: number) {
    this.#state = seed >>> 0;
  }

  #u32(): number {
    this.#state = (this.#state + 0x6d2b79f5) >>> 0;
    let t = this.#state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  }

  next(): number {
    return this.#u32() / 0x1_0000_0000;
  }

  int(n: number): number {
    return Math.floor(this.next() * n);
  }

  normal(): number {
    if (this.#spare !== undefined) {
      const spare = this.#spare;
      this.#spare = undefined;
      return spare;
    }
    // Box–Muller; 1 − next() is in (0, 1], so the log is finite.
    const r = Math.sqrt(-2 * Math.log(1 - this.next()));
    const theta = 2 * Math.PI * this.next();
    this.#spare = r * Math.sin(theta);
    return r * Math.cos(theta);
  }
}

/**
 * Seeded named streams. Each stream's seed mixes the run seed with a hash of
 * its name, so streams are independent and adding one never shifts another.
 * A usable implementation, not only a fake; P1-A may adopt or replace it.
 */
export function createRngStreams(seed: number): RngStreams {
  const streams = new Map<string, Rng>();
  return {
    seed,
    stream(name: string): Rng {
      let rng = streams.get(name);
      if (!rng) {
        rng = new Mulberry32((Math.imul(seed >>> 0, 0x9e3779b1) ^ hashName(name)) >>> 0);
        streams.set(name, rng);
      }
      return rng;
    },
  };
}
