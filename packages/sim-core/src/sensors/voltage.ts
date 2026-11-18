import type { PartContext } from '../api/parts.ts';
import type { SensorContext, SensorModel, SensorReading } from '../api/sensors.ts';

export function createVoltageSensorModel(part: PartContext): SensorModel {
  const definition = part.definition;
  if (!('behavior' in definition)) throw new Error(`${part.instance.instanceId} has no behavior`);
  const behavior = definition.behavior;
  if (behavior.template !== 'voltage-divider')
    throw new Error(`${part.instance.instanceId} is not a voltage-divider`);

  const params = behavior.params;

  // Stage 1: constant pack voltage. A hook for stage-2 sag lives here.
  let packVoltageV = 12;
  for (const instance of part.car.parts) {
    const def = part.catalog.get(instance.partId);
    if (def && 'behavior' in def && def.behavior.template === 'battery') {
      packVoltageV = def.behavior.params.cells * def.behavior.params.cellNominalV;
      break;
    }
  }
  // Hook for stage-2 sag: replace the above constant with a sag model keyed on
  // load current. Stage 1 keeps it constant.
  const packVoltage = (): number => packVoltageV;

  const ratio = params.r2Ohm / (params.r1Ohm + params.r2Ohm);
  const dividedV = packVoltage() * ratio;

  const periodUs = Math.round(1_000_000 / 10);
  let nextUs = 0;

  const model: SensorModel = {
    instanceId: part.instance.instanceId,
    template: behavior.template,
    update(context: SensorContext): readonly SensorReading[] {
      const out: SensorReading[] = [];
      while (nextUs < context.nowUs) {
        const tUs = nextUs;
        out.push({ type: 'analog', tUs, volts: dividedV });
        nextUs += periodUs;
      }
      return out;
    },
    beams(): readonly [] {
      return [];
    },
  };
  return model;
}
