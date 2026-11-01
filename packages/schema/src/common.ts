import { z } from 'zod';

/** Version of every data file format in this package. Bump on breaking changes. */
export const SCHEMA_VERSION = 1;

export const SchemaVersion = z
  .literal(SCHEMA_VERSION)
  .describe('Data file format version. Readers reject versions they do not know.');
export type SchemaVersion = z.infer<typeof SchemaVersion>;

/** Optional `$schema` key so editors can validate data files against the JSON Schemas. */
export const JsonSchemaRef = z.string().optional().describe('Path or URL of the JSON Schema.');

/**
 * Part definition id: lowercase, dot-namespaced by category or vendor, e.g.
 * `sensor.vl53l0x` or `controller.esp32-devkitc`.
 */
export const PartDefinitionId = z
  .string()
  .regex(
    /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*(?:\.[a-z0-9]+(?:-[a-z0-9]+)*)+$/,
    'a part definition id is lowercase and dot-namespaced, like "sensor.vl53l0x"',
  );
export type PartDefinitionId = z.infer<typeof PartDefinitionId>;

/**
 * Part instance id in car.json. It becomes the prefix of the car config
 * header's macros (`tof_left` gives `TOF_LEFT_XSHUT_PIN`), so it is a
 * lowercase C identifier.
 */
export const InstanceId = z
  .string()
  .max(32)
  .regex(
    /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/,
    'an instance id is a lowercase C identifier like "tof_left": words of letters and digits joined by single underscores',
  );
export type InstanceId = z.infer<typeof InstanceId>;

/** Id of a chassis mount point, e.g. `front-left`. */
export const MountPointId = z
  .string()
  .regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/, 'a mount point id is kebab-case, like "front-left"');
export type MountPointId = z.infer<typeof MountPointId>;

/** Name of a pin as printed on the board, e.g. `VIN`, `SDA`, `XSHUT`, `3V3`. */
export const PinName = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_+-]*$/, 'a pin name is letters, digits, "_", "+" or "-"');
export type PinName = z.infer<typeof PinName>;

/** An ESP32 GPIO number. */
export const GpioNumber = z.int().min(0).max(39);
export type GpioNumber = z.infer<typeof GpioNumber>;

/** A 7-bit I²C address. */
export const I2cAddress = z.int().min(0x08).max(0x77);
export type I2cAddress = z.infer<typeof I2cAddress>;

/** A point or offset in millimetres, in the car frame: +X right, +Y up, −Z forward. */
export const Vec3Mm = z.strictObject({ x: z.number(), y: z.number(), z: z.number() });
export type Vec3Mm = z.infer<typeof Vec3Mm>;

/** Size of a part's bounding box in millimetres. */
export const DimensionsMm = z.strictObject({
  width: z.number().positive().describe('Along X (left to right).'),
  height: z.number().positive().describe('Along Y (bottom to top).'),
  length: z.number().positive().describe('Along Z (front to back).'),
});
export type DimensionsMm = z.infer<typeof DimensionsMm>;

/** A closed interval. */
export function range(description: string) {
  return z
    .strictObject({ min: z.number(), max: z.number() })
    .refine((r) => r.min <= r.max, 'min must not exceed max')
    .describe(description);
}

/** Formats an I²C address as in datasheets: `0x29`. */
export function hex(address: number): string {
  return `0x${address.toString(16).toUpperCase().padStart(2, '0')}`;
}

/**
 * Converts a name to the macro-safe form used in the car config header:
 * `tof_left` → `TOF_LEFT`, `BAT+` → `BAT_POS`, `BAT-` → `BAT_NEG`.
 */
export function macroName(name: string): string {
  return name
    .toUpperCase()
    .replace(/\+$/, '_POS')
    .replace(/-$/, '_NEG')
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}
