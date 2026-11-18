import type { PartContext } from '../api/parts.ts';
import type { SensorContext, SensorModel, SensorReading } from '../api/sensors.ts';
import type { Vec3 } from '../api/math.ts';
import { sensorTransform, worldToBody } from './pose.ts';

/** Gravity, m/s² (matches the world's vertical gravity). */
const GRAVITY_MS2 = 9.81;

export function createImuSensorModel(part: PartContext): SensorModel {
  const definition = part.definition;
  if (!('behavior' in definition)) throw new Error(`${part.instance.instanceId} has no behavior`);
  const behavior = definition.behavior;
  if (behavior.template !== 'imu')
    throw new Error(`${part.instance.instanceId} is not an imu sensor`);
  const params = behavior.params;

  // The part's updateHz is the IMU's output rate and the noise bandwidth.
  // Exact accumulator index (avoids per-second drift).
  let readIndex = 0;

  const accelNoiseSigma =
    params.accelNoiseDensityUgPerSqrtHz * 1e-6 * GRAVITY_MS2 * Math.sqrt(params.updateHz);
  const gyroNoiseSigma =
    ((params.gyroNoiseDensityDpsPerSqrtHz * Math.PI) / 180) * Math.sqrt(params.updateHz);

  // Per-run constant biases, drawn once from the bias stream so they never
  // shift the noise sequence. Named scales: small zero-mean offsets.
  const ACCEL_BIAS_SCALE_MS2 = 0.05;
  const GYRO_BIAS_SCALE_RAD_S = 0.01;

  const biasRng = part.stream('bias');
  const accelBias: number[] = [
    biasRng.normal() * ACCEL_BIAS_SCALE_MS2,
    biasRng.normal() * ACCEL_BIAS_SCALE_MS2,
    biasRng.normal() * ACCEL_BIAS_SCALE_MS2,
  ];
  const gyroBias: number[] = [
    biasRng.normal() * GYRO_BIAS_SCALE_RAD_S,
    biasRng.normal() * GYRO_BIAS_SCALE_RAD_S,
    biasRng.normal() * GYRO_BIAS_SCALE_RAD_S,
  ];

  const accelRangeMs2 = params.defaultAccelRangeG * GRAVITY_MS2;
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
      // Specific force in the world frame: a - g (g points down).
      const worldSpecific: Vec3 = [a[0], a[1] + GRAVITY_MS2, a[2]];
      const bodyAccel = worldToBody(t.rotation, worldSpecific);
      const bodyGyro = worldToBody(t.rotation, context.vehicle.angularVelocity);

      // Chip axes for a zero-rotation placement: chip +X = body +X (right),
      // chip +Y = body -Z (forward), chip +Z = body +Y (up).
      // accel/gyro are therefore (body.x, -body.z, body.y).
      const baseAccelChip: Vec3 = [bodyAccel[0], -bodyAccel[2], bodyAccel[1]];
      const baseGyroChip: Vec3 = [bodyGyro[0], -bodyGyro[2], bodyGyro[1]];

      const out: SensorReading[] = [];
      while (true) {
        const tUs = Math.floor((readIndex * 1_000_000) / params.updateHz);
        if (tUs >= context.nowUs) break;
        const accel: Vec3 = [
          clamp(
            baseAccelChip[0] + accelBias[0]! + context.rng.normal() * accelNoiseSigma,
            accelRangeMs2,
          ),
          clamp(
            baseAccelChip[1] + accelBias[1]! + context.rng.normal() * accelNoiseSigma,
            accelRangeMs2,
          ),
          clamp(
            baseAccelChip[2] + accelBias[2]! + context.rng.normal() * accelNoiseSigma,
            accelRangeMs2,
          ),
        ];
        const gyro: Vec3 = [
          clamp(
            baseGyroChip[0] + gyroBias[0]! + context.rng.normal() * gyroNoiseSigma,
            gyroRangeRads,
          ),
          clamp(
            baseGyroChip[1] + gyroBias[1]! + context.rng.normal() * gyroNoiseSigma,
            gyroRangeRads,
          ),
          clamp(
            baseGyroChip[2] + gyroBias[2]! + context.rng.normal() * gyroNoiseSigma,
            gyroRangeRads,
          ),
        ];
        out.push({ type: 'imu', tUs, accel, gyro, tempC: 25 });
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
