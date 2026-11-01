import type { Car, Catalog, ChassisDefinition, Part, PartDefinition } from '@rcsim/schema';
import type { Rng } from './clock.ts';

/** Everything a model needs to know about the part it models. */
export interface PartContext {
  readonly car: Car;
  readonly catalog: Catalog;
  readonly instance: Part;
  readonly definition: PartDefinition;
  readonly chassis: ChassisDefinition;
  /**
   * The part's GPIO-wired pins, by part pin name (`SIGNAL` → 25), resolved
   * through voltage dividers the way the car config header resolves them.
   */
  readonly gpioPins: Readonly<Record<string, number>>;
  /**
   * This part's own random streams: `stream()` is `sensor:<instanceId>`
   * (also handed to `update` as `SensorContext.rng`), and `stream('bias')`
   * is `sensor:<instanceId>:bias`. Draw a per-run constant (a bias) from a
   * suffixed stream so it never shifts the noise sequence.
   */
  stream(suffix?: string): Rng;
}
