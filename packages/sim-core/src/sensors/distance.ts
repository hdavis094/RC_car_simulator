import type { PartContext } from '../api/parts.ts';
import type { SensorBeam, SensorContext, SensorModel, SensorReading } from '../api/sensors.ts';
import type { Vec3 } from '../api/math.ts';
import { sensorTransform } from './pose.ts';
import { rotate } from '../world/quat.ts';

const OUT_OF_RANGE_MM = 8190;
const START_DELAY_US = 200;
const SOUND_SPEED_MPS = 343;

export function createDistanceSensorModel(part: PartContext): SensorModel {
  const definition = part.definition;
  if (!('behavior' in definition)) throw new Error(`${part.instance.instanceId} has no behavior`);
  const behavior = definition.behavior;
  if (behavior.template !== 'distance-raycast')
    throw new Error(`${part.instance.instanceId} is not a distance-raycast sensor`);
  const params = behavior.params;
  const minRangeM = params.minRangeMm / 1000;
  const maxRangeM = params.maxRangeMm / 1000;
  const beamRad = (params.beamAngleDeg * Math.PI) / 180;
  const n = params.rays;
  const angles: number[] =
    n === 1 ? [0] : Array.from({ length: n }, (_, i) => -beamRad / 2 + (i * beamRad) / (n - 1));
  const localDirs: Vec3[] = angles.map((a) => [Math.sin(a), 0, -Math.cos(a)]);

  const isHc = definition.id.includes('hc-sr04');
  const trigGpio = part.gpioPins['TRIG'];
  const echoGpio = part.gpioPins['ECHO'];

  const periodUs = Math.round(1_000_000 / params.updateHz);
  let nextUs = 0;
  let beams: SensorBeam[] = [];

  // HC-SR04 state
  let trigHighStart: number | null = null;
  const pendingTriggers: number[] = [];
  interface ScheduledEdge {
    gpio: number;
    tUs: number;
    level: boolean;
  }
  const scheduled: ScheduledEdge[] = [];
  let tickUs = 1000;

  function doCast(
    world: SensorContext['world'],
    vehicle: SensorContext['vehicle'],
  ): {
    nearest: number | null;
    newBeams: SensorBeam[];
  } {
    const t = sensorTransform(part, vehicle);
    const origin = t.position;
    let nearest: number | null = null;
    const newBeams: SensorBeam[] = [];
    for (const localDir of localDirs) {
      const worldDir = rotate(t.rotation, localDir) as Vec3;
      const hit = world.raycast(origin, worldDir, maxRangeM, { excludeVehicle: true });
      const hitM = hit ? hit.distanceM : null;
      if (hitM !== null && (nearest === null || hitM < nearest)) nearest = hitM;
      newBeams.push({
        origin,
        direction: worldDir,
        maxRangeM,
        hitM,
      });
    }
    return { nearest, newBeams };
  }

  function processTrigger(trigUs: number, context: SensorContext): void {
    const { nearest } = doCast(context.world, context.vehicle);
    const tickIndex = Math.floor(trigUs / tickUs);
    const t1 = (tickIndex + 1) * tickUs;
    const rise = Math.max(trigUs + START_DELAY_US, t1);
    if (nearest === null || nearest < minRangeM || nearest > maxRangeM) {
      // timeout: no echo
      return;
    }
    const distMm = nearest * 1000;
    const sigmaMm = (params.noiseSigmaPct / 100) * distMm;
    const noisyDistM = (distMm + context.rng.normal() * sigmaMm) / 1000;
    const highTimeUs = Math.round(((2 * noisyDistM) / SOUND_SPEED_MPS) * 1_000_000);
    if (echoGpio === undefined) return;
    scheduled.push({ gpio: echoGpio, tUs: rise, level: true });
    scheduled.push({ gpio: echoGpio, tUs: rise + highTimeUs, level: false });
  }

  const model: SensorModel = {
    instanceId: part.instance.instanceId,
    template: behavior.template,
    update(context: SensorContext): readonly SensorReading[] {
      tickUs = context.dtUs;
      // Process any HC-SR04 triggers detected last tick.
      if (isHc && pendingTriggers.length > 0) {
        for (const trigUs of pendingTriggers) processTrigger(trigUs, context);
        pendingTriggers.length = 0;
      }

      const { nearest, newBeams } = doCast(context.world, context.vehicle);
      beams = newBeams;

      if (isHc) return [];

      const out: SensorReading[] = [];
      while (nextUs < context.nowUs) {
        const tUs = nextUs;
        if (nearest === null || nearest < minRangeM || nearest > maxRangeM) {
          out.push({ type: 'distance', tUs, mm: OUT_OF_RANGE_MM, status: 'no-target' });
        } else {
          const distMm = nearest * 1000;
          const sigmaMm = (params.noiseSigmaPct / 100) * distMm;
          const noisy = distMm + context.rng.normal() * sigmaMm;
          out.push({ type: 'distance', tUs, mm: Math.round(noisy), status: 'valid' });
        }
        nextUs += periodUs;
      }
      return out;
    },
    onGpioWrite(write) {
      if (!isHc || trigGpio === undefined) return;
      if (write.gpio !== trigGpio) return;
      if (write.level) {
        trigHighStart = write.tUs;
      } else {
        if (trigHighStart !== null && write.tUs - trigHighStart >= 10) {
          pendingTriggers.push(trigHighStart);
        }
        trigHighStart = null;
      }
    },
    takeGpioEdges(
      t0Us: number,
      t1Us: number,
    ): readonly { gpio: number; tUs: number; level: boolean }[] {
      const out = scheduled
        .filter((e) => e.tUs >= t0Us && e.tUs < t1Us)
        .sort((a, b) => a.tUs - b.tUs)
        .map((e) => ({ gpio: e.gpio, tUs: e.tUs, level: e.level }));
      // remove returned
      for (const e of out) {
        const idx = scheduled.findIndex(
          (s) => s.gpio === e.gpio && s.tUs === e.tUs && s.level === e.level,
        );
        if (idx >= 0) scheduled.splice(idx, 1);
      }
      return out;
    },
    beams(): readonly SensorBeam[] {
      return beams;
    },
  };

  return model;
}
