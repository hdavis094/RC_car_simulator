import type { PartContext } from '../api/parts.ts';
import type { SensorContext, SensorModel, SensorReading } from '../api/sensors.ts';
import type { Vec3 } from '../api/math.ts';
import { sensorTransform, worldToBody } from './pose.ts';

export function createImuSensorModel(part: PartContext): SensorModel {
  const definition = part.definition;
  if (!('behavior' in definition)) throw new Error(`${part.instance.instanceId} has no behavior`);
  const behavior = definition.behavior;
  if (behavior.template !== 'imu')
    throw new Error(`${part.instance.instanceId} is not an imu sensor`);
  const params = behavior.params;

  const periodUs = Math.round(1_000_000 / params.updateHz);
  let nextUs = 0;

  const accelNoiseSigma =
    params.accelNoiseDensityUgPerSqrtHz * 1e-6 * 9.81 * Math.sqrt(params.updateHz);
  const gyroNoiseSigma =
    ((params.gyroNoiseDensityDpsPerSqrtHz * Math.PI) / 180) * Math.sqrt(params.updateHz);

  const accelBiasScale = 0.05; // m/s², per-run
  const gyroBiasScale = 0.01; // rad/s, per-run

  const biasRng = part.stream('bias');
  const accelBias: number[] = [
    biasRng.normal() * accelBiasScale,
    biasRng.normal() * accelBiasScale,
    biasRng.normal() * accelBiasScale,
  ];
  const gyroBias: number[] = [
    biasRng.normal() * gyroBiasScale,
    biasRng.normal() * gyroBiasScale,
    biasRng.normal() * gyroBiasScale,
  ];

  const accelRangeMs2 = params.defaultAccelRangeG * 9.81;
  const gyroRangeRads = (params.defaultGyroRangeDps * Math.PI) / 180;

  function clamp(v: number, limit: number): number {
    return Math.max(-limit, Math.min(limit, v));
  }

  const model: SensorModel = {
    instanceId: part.instance.instanceId,
    template: behavior.template,
    update(context: SensorContext): readonly SensorReading[] {
      const t = sensorTransform(part, context.vehicle);
      const a = context.vehicle.acceleration;
      const worldSpecific: Vec3 = [a[0], a[1] + 9.81, a[2]];
      const baseAccel = worldToBody(t.rotation, worldSpecific);
      const baseGyro = worldToBody(t.rotation, context.vehicle.angularVelocity);

      const out: SensorReading[] = [];
      while (nextUs < context.nowUs) {
        const tUs = nextUs;
        const accel: Vec3 = [
          clamp(
            baseAccel[0] + accelBias[0]! + context.rng.normal() * accelNoiseSigma,
            accelRangeMs2,
          ),
          clamp(
            baseAccel[1] + accelBias[1]! + context.rng.normal() * accelNoiseSigma,
            accelRangeMs2,
          ),
          clamp(
            baseAccel[2] + accelBias[2]! + context.rng.normal() * accelNoiseSigma,
            accelRangeMs2,
          ),
        ];
        const gyro: Vec3 = [
          clamp(baseGyro[0] + gyroBias[0]! + context.rng.normal() * gyroNoiseSigma, gyroRangeRads),
          clamp(baseGyro[1] + gyroBias[1]! + context.rng.normal() * gyroNoiseSigma, gyroRangeRads),
          clamp(baseGyro[2] + gyroBias[2]! + context.rng.normal() * gyroNoiseSigma, gyroRangeRads),
        ];
        out.push({ type: 'imu', tUs, accel, gyro, tempC: 25 });
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
