import type { PartContext } from '../api/parts.ts';
import type { SensorContext, SensorModel, SensorReading } from '../api/sensors.ts';
import { dividerRatio } from '@rcsim/schema';

/** The battery as it stands during the run: physics stage 2's sagging pack. */
export interface LivePack {
  /** Terminal voltage after the last physics step, volts. */
  readonly packVolts: number;
}

/** Readings per second of a live pack, fast enough to see a launch pull it down. */
const LIVE_RATE_HZ = 100;

/**
 * The analog voltage at a divider's OUT pin. With no `pack` (physics stage 1)
 * the battery holds its nominal voltage and is read 10 times a second.
 */
export function createVoltageSensorModel(part: PartContext, pack?: LivePack): SensorModel {
  const definition = part.definition;
  if (!('behavior' in definition)) throw new Error(`${part.instance.instanceId} has no behavior`);
  const behavior = definition.behavior;
  if (behavior.template !== 'voltage-divider')
    throw new Error(`${part.instance.instanceId} is not a voltage-divider`);

  const params = behavior.params;
  const ratio = dividerRatio(params);

  function nominalVoltage(): number {
    for (const instance of part.car.parts) {
      const def = part.catalog.get(instance.partId);
      if (def && 'behavior' in def && def.behavior.template === 'battery') {
        return def.behavior.params.cells * def.behavior.params.cellNominalV;
      }
    }
    // Also check controller? Batteries are parts. If none, fail loudly.
    throw new Error(`${part.instance.instanceId}: no battery part found in car`);
  }
  const packVoltage = (): number => {
    const nominal = nominalVoltage(); // a divider with no battery is an error in either stage
    return pack ? pack.packVolts : nominal;
  };

  // Rate: use the part's updateHz if it defines one, else by the kind of pack.
  const rateHz = (params as { updateHz?: number }).updateHz ?? (pack ? LIVE_RATE_HZ : 10);
  let readIndex = 0;

  const model: SensorModel = {
    instanceId: part.instance.instanceId,
    template: behavior.template,
    update(context: SensorContext): readonly SensorReading[] {
      const out: SensorReading[] = [];
      while (true) {
        const tUs = Math.floor((readIndex * 1_000_000) / rateHz);
        if (tUs >= context.nowUs) break;
        out.push({ type: 'analog', tUs, volts: packVoltage() * ratio });
        readIndex += 1;
      }
      return out;
    },
    beams(): readonly [] {
      return [];
    },
  };
  return model;
}
