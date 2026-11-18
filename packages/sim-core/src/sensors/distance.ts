import type { PartContext } from '../api/parts.ts';
import type { SensorBeam, SensorContext, SensorModel, SensorReading } from '../api/sensors.ts';
import type { Vec3 } from '../api/math.ts';
import { sensorTransform } from './pose.ts';
import { rotate } from '../world/quat.ts';

const OUT_OF_RANGE_MM = 8190;
/** Start delay after TRIG falling edge before ECHO rises (8 cycles at 40 kHz). */
const START_DELAY_US = 200;
/** Sound speed, m/s. */
const SOUND_SPEED_MPS = 343;
/**
 * HC-SR04 ECHO high time when nothing is in range. Cited: HC-SR04 datasheet
 * (Cytron) — no echo is reported as a ~38 ms pulse.
 */
const TIMEOUT_HIGH_US = 38_000;

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

  // A part is an HC-SR04 when it exposes TRIG and ECHO pins.
  const isHc = part.gpioPins['TRIG'] !== undefined && part.gpioPins['ECHO'] !== undefined;
  const trigGpio = part.gpioPins['TRIG'];
  const echoGpio = part.gpioPins['ECHO'];

  let readIndex = 0;
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

  function processTrigger(trigFallUs: number, context: SensorContext): void {
    const { nearest } = doCast(context.world, context.vehicle);
    const tickNow = context.nowUs;
    const rise = Math.max(trigFallUs + START_DELAY_US, tickNow);
    if (echoGpio === undefined) return;
    if (nearest === null || nearest < minRangeM || nearest > maxRangeM) {
      // Timeout behaviour: hold ECHO high for TIMEOUT_HIGH_US.
      scheduled.push({ gpio: echoGpio, tUs: rise, level: true });
      scheduled.push({ gpio: echoGpio, tUs: rise + TIMEOUT_HIGH_US, level: false });
      return;
    }
    const distMm = nearest * 1000;
    const sigmaMm = (params.noiseSigmaPct / 100) * distMm;
    const noisyDistM = (distMm + context.rng.normal() * sigmaMm) / 1000;
    const highTimeUs = Math.round(((2 * noisyDistM) / SOUND_SPEED_MPS) * 1_000_000);
    scheduled.push({ gpio: echoGpio, tUs: rise, level: true });
    scheduled.push({ gpio: echoGpio, tUs: rise + highTimeUs, level: false });
  }

  const model: SensorModel = {
    instanceId: part.instance.instanceId,
    template: behavior.template,
    update(context: SensorContext): readonly SensorReading[] {
      // Process any HC-SR04 triggers detected since the last tick.
      if (isHc && pendingTriggers.length > 0) {
        for (const trigFallUs of pendingTriggers) processTrigger(trigFallUs, context);
        pendingTriggers.length = 0;
      }

      const { nearest, newBeams } = doCast(context.world, context.vehicle);
      beams = newBeams;

      if (isHc) return [];

      const out: SensorReading[] = [];
      while (true) {
        const tUs = Math.floor((readIndex * 1_000_000) / params.updateHz);
        if (tUs >= context.nowUs) break;
        if (nearest === null || nearest < minRangeM || nearest > maxRangeM) {
          out.push({ type: 'distance', tUs, mm: OUT_OF_RANGE_MM, status: 'no-target' });
        } else {
          const distMm = nearest * 1000;
          const sigmaMm = (params.noiseSigmaPct / 100) * distMm;
          const noisy = distMm + context.rng.normal() * sigmaMm;
          out.push({ type: 'distance', tUs, mm: Math.round(noisy), status: 'valid' });
        }
        readIndex += 1;
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
          pendingTriggers.push(write.tUs); // anchor on falling edge
        }
        trigHighStart = null;
      }
    },
    takeGpioEdges(
      t0Us: number,
      t1Us: number,
    ): readonly { gpio: number; tUs: number; level: boolean }[] {
      // Purge stale edges before the current window.
      for (let i = scheduled.length - 1; i >= 0; i--) {
        if (scheduled[i]!.tUs < t0Us) scheduled.splice(i, 1);
      }
      const out = scheduled
        .filter((e) => e.tUs >= t0Us && e.tUs < t1Us)
        .sort((a, b) => a.tUs - b.tUs)
        .map((e) => ({ gpio: e.gpio, tUs: e.tUs, level: e.level }));
      // Remove delivered edges.
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
