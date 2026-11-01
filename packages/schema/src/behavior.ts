import { z } from 'zod';

const positive = z.number().positive();
const nonNegative = z.number().min(0);
const pulseUs = z.number().min(500).max(2500);

export const DistanceRaycastParams = z
  .strictObject({
    minRangeMm: nonNegative.describe('Closest distance the part reports.'),
    maxRangeMm: positive.describe('Farthest distance the part reports.'),
    beamAngleDeg: z.number().gt(0).max(180).describe('Full cone angle of the beam.'),
    rays: z.int().min(1).max(64).describe('Rays cast across the cone; the nearest hit wins.'),
    noiseSigmaPct: nonNegative.describe('Standard deviation of Gaussian noise, % of distance.'),
    updateHz: positive.describe('Readings per second.'),
  })
  .refine((p) => p.minRangeMm < p.maxRangeMm, 'minRangeMm must be below maxRangeMm');

export const ImuParams = z
  .strictObject({
    accelRangesG: z.array(positive).min(1).describe('Selectable ± full-scale ranges, in g.'),
    defaultAccelRangeG: positive.describe('Full-scale range after power-on.'),
    gyroRangesDps: z.array(positive).min(1).describe('Selectable ± full-scale ranges, in °/s.'),
    defaultGyroRangeDps: positive.describe('Full-scale range after power-on.'),
    accelNoiseDensityUgPerSqrtHz: nonNegative,
    gyroNoiseDensityDpsPerSqrtHz: nonNegative,
    updateHz: positive.describe('Readings per second.'),
  })
  .refine((p) => p.accelRangesG.includes(p.defaultAccelRangeG), 'default accel range not listed')
  .refine((p) => p.gyroRangesDps.includes(p.defaultGyroRangeDps), 'default gyro range not listed');

export const ServoParams = z
  .strictObject({
    travelDeg: positive.describe('Total output travel from pulseMinUs to pulseMaxUs.'),
    slewDegPerS: positive.describe('Maximum output speed.'),
    pulseMinUs: pulseUs,
    pulseNeutralUs: pulseUs,
    pulseMaxUs: pulseUs,
    deadbandUs: nonNegative.describe('Pulse change the servo ignores.'),
    stallTorqueNm: positive.optional(),
  })
  .refine(
    (p) => p.pulseMinUs < p.pulseNeutralUs && p.pulseNeutralUs < p.pulseMaxUs,
    'pulses must satisfy min < neutral < max',
  );

export const ThrottleCurvePoint = z.strictObject({
  input: z.number().min(0).max(1).describe('Throttle command magnitude, 0..1.'),
  output: z.number().min(0).max(1).describe('Fraction of full motor voltage, 0..1.'),
});

export const EscMotorParams = z
  .strictObject({
    pulseMinUs: pulseUs.describe('Full reverse (or full brake).'),
    pulseNeutralUs: pulseUs,
    pulseMaxUs: pulseUs.describe('Full forward.'),
    deadbandUs: nonNegative.describe('± band around neutral that gives zero output.'),
    armingMs: nonNegative.describe('Neutral must be held this long after power-on to arm.'),
    reverse: z.boolean().describe('Whether pulses below neutral drive in reverse.'),
    kvRpmPerV: positive.describe('Motor speed constant, rpm per volt, unloaded.'),
    maxTorqueNm: positive.describe('Motor stall torque at the nominal battery voltage.'),
    throttleCurve: z
      .array(ThrottleCurvePoint)
      .min(2)
      .describe('Piecewise-linear map from command to output, inputs from 0 to 1.'),
  })
  .refine(
    (p) => p.pulseMinUs < p.pulseNeutralUs && p.pulseNeutralUs < p.pulseMaxUs,
    'pulses must satisfy min < neutral < max',
  )
  .refine((p) => {
    const inputs = p.throttleCurve.map((point) => point.input);
    return (
      inputs[0] === 0 &&
      inputs[inputs.length - 1] === 1 &&
      inputs.every((input, i) => i === 0 || input > (inputs[i - 1] ?? 0))
    );
  }, 'throttleCurve inputs must rise strictly from 0 to 1');

export const BatteryParams = z
  .strictObject({
    cells: z.int().min(1).max(12),
    cellNominalV: positive,
    cellFullV: positive,
    cellEmptyV: positive.describe('Cell voltage at which the pack counts as empty.'),
    capacityMah: positive,
    internalResistanceMohm: nonNegative.describe('Whole pack.'),
    maxContinuousC: positive,
  })
  .refine(
    (p) => p.cellEmptyV < p.cellNominalV && p.cellNominalV < p.cellFullV,
    'cell voltages must satisfy empty < nominal < full',
  );

export const VoltageDividerParams = z.strictObject({
  r1Ohm: positive.describe('Top resistor, from IN to OUT.'),
  r2Ohm: positive.describe('Bottom resistor, from OUT to GND.'),
});

export const RegulatorParams = z.strictObject({
  topology: z.enum(['buck', 'linear']),
  outputV: positive,
  maxCurrentMa: positive,
  efficiencyPct: z
    .number()
    .gt(0)
    .max(100)
    .optional()
    .describe('Buck efficiency. Linear regulators pass their output current through.'),
});

/** How a part behaves in the sim: one built-in template plus its parameters. */
export const Behavior = z.discriminatedUnion('template', [
  z.strictObject({ template: z.literal('distance-raycast'), params: DistanceRaycastParams }),
  z.strictObject({ template: z.literal('imu'), params: ImuParams }),
  z.strictObject({ template: z.literal('servo'), params: ServoParams }),
  z.strictObject({ template: z.literal('esc-motor'), params: EscMotorParams }),
  z.strictObject({ template: z.literal('battery'), params: BatteryParams }),
  z.strictObject({ template: z.literal('voltage-divider'), params: VoltageDividerParams }),
  z.strictObject({ template: z.literal('regulator'), params: RegulatorParams }),
]);
export type Behavior = z.infer<typeof Behavior>;
export type BehaviorTemplate = Behavior['template'];

export const BEHAVIOR_TEMPLATES = [
  'distance-raycast',
  'imu',
  'servo',
  'esc-motor',
  'battery',
  'voltage-divider',
  'regulator',
] as const satisfies readonly BehaviorTemplate[];

/** Ratio OUT/IN of a voltage divider. */
export function dividerRatio(params: z.infer<typeof VoltageDividerParams>): number {
  return params.r2Ohm / (params.r1Ohm + params.r2Ohm);
}
