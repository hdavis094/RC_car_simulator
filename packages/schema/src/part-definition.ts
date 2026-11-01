import { z } from 'zod';
import { Behavior, isDivider } from './behavior.ts';
import {
  DimensionsMm,
  GpioNumber,
  I2cAddress,
  JsonSchemaRef,
  MountPointId,
  PartDefinitionId,
  PinName,
  SchemaVersion,
  Vec3Mm,
  macroName,
  range,
} from './common.ts';

/** Kinds through which a part receives a signal. */
export const INPUT_KINDS: ReadonlySet<string> = new Set([
  'digital-in',
  'pwm-in',
  'analog-in',
  'i2c-sda',
  'i2c-scl',
]);

/**
 * What a pin does, seen from the part that has it. `digital-in` means the
 * part reads the line (the controller drives it); `digital-out` means the
 * part drives the line (the controller reads it).
 */
export const PinKind = z.enum([
  'power-in',
  'power-out',
  'gnd',
  'i2c-sda',
  'i2c-scl',
  'pwm-in',
  'digital-in',
  'digital-out',
  'analog-in',
  'analog-out',
]);
export type PinKind = z.infer<typeof PinKind>;

/**
 * The voltage on a pin.
 * - a number: the highest voltage the pin presents (outputs, power-out) or
 *   expects (inputs);
 * - `{min, max}`: a power-out whose voltage varies, like a battery;
 * - `"supply"`: equal to whatever the part's power-in pin is connected to
 *   (breakouts with level shifters to VIN).
 * When omitted on a signal pin it defaults to the part's `electrical.logicLevelV`.
 * A voltage-divider's OUT pin has none: it is derived from what drives IN.
 */
export const PinVoltage = z.union([
  z.number().positive(),
  range('Voltage range of a varying source.'),
  z.literal('supply'),
]);
export type PinVoltage = z.infer<typeof PinVoltage>;

export const PinDefinition = z.strictObject({
  name: PinName,
  kind: PinKind,
  voltage: PinVoltage.optional(),
  maxCurrentMa: z
    .number()
    .positive()
    .optional()
    .describe('power-out only: the most current the rail may supply.'),
  maxInputV: z
    .number()
    .positive()
    .optional()
    .describe(
      'Inputs only: the highest voltage the pin tolerates, when above its nominal level (e.g. 3.6 V absolute maximum on a 2.8 V pin).',
    ),
  optional: z
    .boolean()
    .optional()
    .describe('The part works with this pin unconnected (no warning when left open).'),
  description: z.string().optional(),
});
export type PinDefinition = z.infer<typeof PinDefinition>;

export const Electrical = z.strictObject({
  supplyV: range('Allowed voltage on the power-in pin.'),
  logicLevelV: z
    .union([z.number().positive(), z.literal('supply')])
    .describe('Signal level of the part. "supply" means it follows the power-in voltage.'),
  currentMa: z
    .strictObject({ typical: z.number().min(0), peak: z.number().min(0) })
    .refine((c) => c.typical <= c.peak, 'typical current must not exceed peak')
    .describe('Current drawn from the power-in pin, excluding what its power-out pins supply.'),
});
export type Electrical = z.infer<typeof Electrical>;

/** How a part sits on an I²C bus. */
export const I2cInfo = z.strictObject({
  defaultAddress: I2cAddress.describe('Address after power-on.'),
  addressing: z
    .discriminatedUnion('kind', [
      z.strictObject({ kind: z.literal('fixed') }),
      z.strictObject({
        kind: z.literal('strap'),
        addresses: z
          .array(I2cAddress)
          .length(2)
          .describe('[address with the pin low, address with it high].'),
        pin: PinName.describe('Pin that selects the address.'),
      }),
      z.strictObject({
        kind: z.literal('software'),
        enablePin: PinName.describe(
          'Pin that holds the part off the bus while others are re-addressed (e.g. XSHUT).',
        ),
      }),
    ])
    .describe('How the address can change from its default.'),
});
export type I2cInfo = z.infer<typeof I2cInfo>;

const partBase = {
  $schema: JsonSchemaRef,
  schemaVersion: SchemaVersion,
  id: PartDefinitionId,
  name: z.string().min(1),
  manufacturer: z.string().optional(),
  description: z.string().optional(),
  massG: z.number().min(0),
  dimensionsMm: DimensionsMm,
  modelPath: z.string().optional().describe('glTF model, relative to this file.'),
  pins: z.array(PinDefinition),
  sources: z.array(z.url()).min(1).describe('Datasheets and product pages the values come from.'),
  notes: z.string().optional().describe('Assumptions and estimated values, with reasons.'),
};

/** Capabilities of one controller GPIO. Absent flags are false. */
export const GpioDefinition = z.strictObject({
  gpio: GpioNumber,
  label: z.string().optional().describe('Header label when it differs from the number.'),
  inputOnly: z.boolean().optional(),
  adc1Channel: z.int().min(0).optional(),
  adc2Channel: z.int().min(0).optional(),
  touchChannel: z.int().min(0).optional(),
  strapping: z.boolean().optional(),
  flash: z.boolean().optional().describe('Wired to the module flash.'),
  uart0: z.enum(['tx', 'rx']).optional().describe('Used by the USB serial bridge.'),
});
export type GpioDefinition = z.infer<typeof GpioDefinition>;

export const ControllerDefinition = z.strictObject({
  ...partBase,
  category: z.literal('controller'),
  electrical: Electrical,
  gpios: z.array(GpioDefinition).min(1),
  gpioMaxInputV: z.number().positive().describe('Highest voltage a GPIO accepts.'),
});
export type ControllerDefinition = z.infer<typeof ControllerDefinition>;

export const MountPoint = z.strictObject({
  id: MountPointId,
  positionMm: Vec3Mm.describe('In the chassis frame.'),
  yawDeg: z.number().describe('Default heading; positive turns left, seen from above.'),
  pitchDeg: z.number().describe('Default pitch; positive tilts up.'),
});
export type MountPoint = z.infer<typeof MountPoint>;

/**
 * Chassis frame: origin on the ground, midway between the axles and centred
 * left to right. +X right, +Y up, −Z forward.
 */
export const ChassisDefinition = z.strictObject({
  ...partBase,
  category: z.literal('chassis'),
  wheelbaseMm: z.number().positive(),
  trackWidthMm: z.number().positive().describe('Between the tyre centres.'),
  wheelRadiusMm: z.number().positive(),
  maxSteeringAngleDeg: z.number().gt(0).lt(90).describe('Inner front wheel at full lock.'),
  steeringLinkageRatio: z
    .number()
    .refine((v) => v !== 0, 'steeringLinkageRatio must not be 0')
    .describe(
      'Front-wheel degrees per degree of steering-servo travel, up to full lock. Positive: servo pulses above neutral steer right; negative: they steer left (a reversed servo).',
    ),
  driveWheels: z.enum(['rear', 'front', 'all']),
  finalDriveRatio: z.number().positive().describe('Motor turns per wheel turn.'),
  centreOfGravityMm: Vec3Mm.describe('Of the chassis alone, in the chassis frame.'),
  mountPoints: z.array(MountPoint).min(1),
});
export type ChassisDefinition = z.infer<typeof ChassisDefinition>;

const behavingCategories = {
  actuator: z.literal('actuator'),
  sensor: z.literal('sensor'),
  power: z.literal('power'),
};

const behavingPart = (category: z.ZodLiteral<'actuator' | 'sensor'>) =>
  z.strictObject({
    ...partBase,
    category,
    electrical: Electrical,
    i2c: I2cInfo.optional(),
    behavior: Behavior,
  });

export const ActuatorDefinition = behavingPart(behavingCategories.actuator);
export const SensorDefinition = behavingPart(behavingCategories.sensor);

/** Power parts. A battery is only a source, so it has no `electrical` (no supply input). */
export const PowerDefinition = z.strictObject({
  ...partBase,
  category: behavingCategories.power,
  electrical: Electrical.optional(),
  behavior: Behavior,
});

/** Passive parts (voltage dividers) draw no meaningful current and have no supply. */
export const PassiveDefinition = z.strictObject({
  ...partBase,
  category: z.literal('passive'),
  behavior: Behavior,
});

export type ActuatorDefinition = z.infer<typeof ActuatorDefinition>;
export type SensorDefinition = z.infer<typeof SensorDefinition>;
export type PowerDefinition = z.infer<typeof PowerDefinition>;
export type PassiveDefinition = z.infer<typeof PassiveDefinition>;

const partDefinitionUnion = z.discriminatedUnion('category', [
  ControllerDefinition,
  ChassisDefinition,
  ActuatorDefinition,
  SensorDefinition,
  PowerDefinition,
  PassiveDefinition,
]);
export type PartCategory = z.infer<typeof partDefinitionUnion>['category'];

/** Every part category, derived from the union so the two can't drift. */
export const PART_CATEGORIES: readonly PartCategory[] = partDefinitionUnion.options.map(
  (option) => option.shape.category.value,
);

const sameRange = (a: { min: number; max: number }, b: { min: number; max: number }): boolean =>
  Math.abs(a.min - b.min) < 1e-9 && Math.abs(a.max - b.max) < 1e-9;

/** A part definition file: one kind of part. */
export const PartDefinition = partDefinitionUnion.superRefine((part, ctx) => {
  const seen = new Map<string, string>();
  part.pins.forEach((pin, i) => {
    const key = macroName(pin.name);
    const clash = seen.get(key);
    if (clash !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['pins', i, 'name'],
        message: `pin "${pin.name}" clashes with "${clash}" (pin names are case-insensitive)`,
      });
    }
    seen.set(key, pin.name);

    if (pin.kind === 'power-out' && pin.voltage === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['pins', i, 'voltage'],
        message: 'a power-out pin needs a voltage',
      });
    }
    if (pin.maxCurrentMa !== undefined && pin.kind !== 'power-out') {
      ctx.addIssue({
        code: 'custom',
        path: ['pins', i, 'maxCurrentMa'],
        message: 'only power-out pins have a current budget',
      });
    }
    if (pin.maxInputV !== undefined && !INPUT_KINDS.has(pin.kind)) {
      ctx.addIssue({
        code: 'custom',
        path: ['pins', i, 'maxInputV'],
        message: 'only input pins have maxInputV',
      });
    }
    if (typeof pin.voltage === 'object' && pin.kind !== 'power-out') {
      ctx.addIssue({
        code: 'custom',
        path: ['pins', i, 'voltage'],
        message: 'only power-out pins have a voltage range',
      });
    }
  });

  const powerIns = part.pins.filter((pin) => pin.kind === 'power-in');
  const usesSupply =
    part.pins.some((pin) => pin.voltage === 'supply') ||
    electricalOf(part)?.logicLevelV === 'supply';
  if (usesSupply && powerIns.length !== 1) {
    ctx.addIssue({
      code: 'custom',
      path: ['pins'],
      message: 'a part whose pins follow its supply needs exactly one power-in pin',
    });
  }

  if ('behavior' in part && part.behavior.template === 'regulator') {
    const { outputV, maxCurrentMa } = part.behavior.params;
    const outputs = part.pins.filter((pin) => pin.kind === 'power-out');
    if (
      outputs.length !== 1 ||
      outputs[0]?.voltage !== outputV ||
      outputs[0]?.maxCurrentMa !== maxCurrentMa
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['pins'],
        message: `a regulator needs one power-out pin with voltage ${outputV} and maxCurrentMa ${maxCurrentMa}, matching its params`,
      });
    }
  }

  if ('behavior' in part && part.behavior.template === 'battery') {
    const { cells, cellEmptyV, cellFullV, capacityMah, maxContinuousC } = part.behavior.params;
    const expected = { min: cells * cellEmptyV, max: cells * cellFullV };
    const outputs = part.pins.filter((pin) => pin.kind === 'power-out');
    const out = outputs[0];
    if (
      outputs.length !== 1 ||
      typeof out?.voltage !== 'object' ||
      !sameRange(out.voltage, expected) ||
      Math.abs((out.maxCurrentMa ?? 0) - capacityMah * maxContinuousC) > 1e-6
    ) {
      const round = (v: number): number => Number(v.toFixed(6));
      ctx.addIssue({
        code: 'custom',
        path: ['pins'],
        message: `a battery needs one power-out pin with voltage {min: ${round(expected.min)}, max: ${round(expected.max)}} and maxCurrentMa ${round(capacityMah * maxContinuousC)}, matching its params`,
      });
    }
  }

  if ('behavior' in part && isDivider(part.behavior)) {
    for (const [name, kind] of [
      ['IN', 'analog-in'],
      ['OUT', 'analog-out'],
    ] as const) {
      if (!part.pins.some((pin) => pin.name === name && pin.kind === kind)) {
        ctx.addIssue({
          code: 'custom',
          path: ['pins'],
          message: `a voltage divider needs an ${kind} pin named ${name}`,
        });
      }
    }
  }

  if ('i2c' in part && part.i2c) {
    const addressing = part.i2c.addressing;
    const pinName = addressing.kind === 'software' ? addressing.enablePin : undefined;
    const strapPin = addressing.kind === 'strap' ? addressing.pin : undefined;
    for (const name of [pinName, strapPin]) {
      if (name !== undefined && !part.pins.some((pin) => pin.name === name)) {
        ctx.addIssue({
          code: 'custom',
          path: ['i2c', 'addressing'],
          message: `i2c addressing names pin "${name}", which the part does not have`,
        });
      }
    }
    if (addressing.kind === 'strap' && addressing.addresses[0] !== part.i2c.defaultAddress) {
      ctx.addIssue({
        code: 'custom',
        path: ['i2c', 'addressing', 'addresses'],
        message: 'the first strap address must be the default address',
      });
    }
  }

  if (part.category === 'controller') {
    const gpios = new Set<number>();
    part.gpios.forEach((gpio, i) => {
      if (gpios.has(gpio.gpio)) {
        ctx.addIssue({
          code: 'custom',
          path: ['gpios', i, 'gpio'],
          message: `GPIO ${gpio.gpio} is listed twice`,
        });
      }
      gpios.add(gpio.gpio);
    });
  }

  if (part.category === 'chassis') {
    const mounts = new Set<string>();
    part.mountPoints.forEach((mount, i) => {
      if (mounts.has(mount.id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['mountPoints', i, 'id'],
          message: `mount point "${mount.id}" is listed twice`,
        });
      }
      mounts.add(mount.id);
    });
  }
});
export type PartDefinition = z.infer<typeof PartDefinition>;

/** Looks up a pin of a part definition by its exact name. */
export function findPin(part: PartDefinition, name: string): PinDefinition | undefined {
  return part.pins.find((pin) => pin.name === name);
}

/** A part's electrical values, if it has any (chassis, batteries and passives may not). */
export function electricalOf(part: PartDefinition): Electrical | undefined {
  return 'electrical' in part ? part.electrical : undefined;
}
