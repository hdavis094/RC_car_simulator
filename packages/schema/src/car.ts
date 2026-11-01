import { z } from 'zod';
import {
  GpioNumber,
  I2cAddress,
  InstanceId,
  JsonSchemaRef,
  MountPointId,
  PartDefinitionId,
  PinName,
  SchemaVersion,
  Vec3Mm,
} from './common.ts';

/** Where one pin of a part is wired: a controller GPIO, or a pin of another part. */
export const PinTarget = z.union([
  z.strictObject({ gpio: GpioNumber }),
  z.strictObject({ part: InstanceId, pin: PinName }),
]);
export type PinTarget = z.infer<typeof PinTarget>;

/**
 * A part's mount point plus fine-tuning. The offset is in the chassis frame
 * (mm); the angles add to the mount point's default orientation.
 */
export const Placement = z.strictObject({
  mount: MountPointId,
  offsetMm: Vec3Mm.optional().describe('Added to the mount point position. Default 0.'),
  yawDeg: z.number().optional().describe('Added to the mount yaw; positive turns left.'),
  pitchDeg: z.number().optional().describe('Added to the mount pitch; positive tilts up.'),
});
export type Placement = z.infer<typeof Placement>;

/**
 * One physical part on the car. `pins` is its pin assignment: part pin name
 * to target. A wire may be declared from either end, and GND pins share a
 * common ground whether or not they are listed.
 */
export const Part = z.strictObject({
  instanceId: InstanceId,
  partId: PartDefinitionId,
  placement: Placement.optional(),
  pins: z.record(PinName, PinTarget).optional(),
  i2cAddress: I2cAddress.optional().describe(
    'Address the firmware gives the part. Defaults to the definition default.',
  ),
});
export type Part = z.infer<typeof Part>;

/** car.json: one car's parts, pin assignments and placement. Written by the Workbench. */
export const Car = z
  .strictObject({
    $schema: JsonSchemaRef,
    schemaVersion: SchemaVersion,
    name: z.string().min(1),
    wifi: z.boolean().describe('The firmware uses Wi-Fi, which makes ADC2 unavailable.'),
    controller: Part,
    chassis: Part.pick({ instanceId: true, partId: true }),
    parts: z.array(Part),
  })
  .superRefine((car, ctx) => {
    const seen = new Set<string>();
    const ids = [
      { id: car.controller.instanceId, path: ['controller', 'instanceId'] },
      { id: car.chassis.instanceId, path: ['chassis', 'instanceId'] },
      ...car.parts.map((part, i) => ({ id: part.instanceId, path: ['parts', i, 'instanceId'] })),
    ];
    for (const { id, path } of ids) {
      if (seen.has(id)) {
        ctx.addIssue({ code: 'custom', path, message: `instance id "${id}" is used twice` });
      }
      seen.add(id);
    }
  });
export type Car = z.infer<typeof Car>;

/** Every part instance of a car, controller first, then the parts in order. */
export function carParts(car: Car): Part[] {
  return [car.controller, ...car.parts];
}
