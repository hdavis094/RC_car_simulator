import type { PartContext } from '../api/parts.ts';
import type { SensorContext, SensorModel, SensorReading } from '../api/sensors.ts';
import { dividerRatio } from '@rcsim/schema';

export function createVoltageSensorModel(part: PartContext): SensorModel {
  const definition = part.definition;
  if (!('behavior' in definition)) throw new Error(`${part.instance.instanceId} has no behavior`);
  const behavior = definition.behavior;
  if (behavior.template !== 'voltage-divider')
    throw new Error(`${part.instance.instanceId} is not a voltage-divider`);

  const params = behavior.params;
  const ratio = dividerRatio(params);

  // Stage 1: constant pack voltage. packVoltage() is evaluated per reading so
  // a stage-2 sag model can replace it without changing the call sites.
  function findBatteryVoltage(): number {
    for (const instance of part.car.parts) {
      const def = part.catalog.get(instance.partId);
      if (def && 'behavior' in def && def.behavior.template === 'battery') {
        return def.behavior.params.cells * def.behavior.params.cellNominalV;
      }
    }
    // Also check controller? Batteries are parts. If none, fail loudly.
    throw new Error(`${part.instance.instanceId}: no battery part found in car`);
  }
  const packVoltage = (): number => findBatteryVoltage();

  // Rate: use the part's updateHz if it defines one, else 10 Hz.
  const rateHz = (params as { updateHz?: number }).updateHz ?? 10;
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
