import type { Car } from './car.ts';
import type { Catalog } from './catalog.ts';
import { Netlist } from './wiring/netlist.ts';

/**
 * The GPIO each signal pin of each part reaches, directly or through voltage
 * dividers, resolved exactly as `generateCarConfigHeader` resolves them.
 * Keyed by instance id, then part pin name: `{ sonar: { TRIG: 13, ECHO: 34 } }`.
 * Parts whose definition is missing are left out; unwired pins are absent.
 */
export function gpioAssignments(
  car: Car,
  catalog: Catalog,
): Record<string, Record<string, number>> {
  const netlist = new Netlist(car, catalog);
  const result: Record<string, Record<string, number>> = {};
  for (const part of netlist.parts) {
    const pins: Record<string, number> = {};
    for (const pin of part.definition.pins) {
      if (pin.kind === 'gnd' || pin.kind === 'power-in' || pin.kind === 'power-out') continue;
      const gpio = netlist.gpioOfPin(part, pin.name);
      if (gpio !== undefined) pins[pin.name] = gpio;
    }
    result[part.instance.instanceId] = pins;
  }
  return result;
}
