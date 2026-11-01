import { z } from 'zod';
import { JsonSchemaRef, SchemaVersion } from './common.ts';
import { GroundPointM, GroundPose } from './world.ts';

/**
 * A built-in track. The centreline is a closed loop; the car drives in the
 * order of its points. A lap counts when the car crosses the start/finish
 * line in that direction.
 */
export const Track = z
  .strictObject({
    $schema: JsonSchemaRef,
    schemaVersion: SchemaVersion,
    id: z.string().regex(/^[a-z][a-z0-9-]*$/),
    name: z.string().min(1),
    centreline: z.strictObject({
      kind: z
        .enum(['polyline', 'catmull-rom'])
        .describe(
          'Straight segments, or a closed centripetal Catmull-Rom spline through the points.',
        ),
      pointsM: z.array(GroundPointM).min(3).describe('Closed: the last point joins the first.'),
    }),
    widthM: z.number().positive(),
    wallHeightM: z.number().min(0).describe('0 means no walls.'),
    startFinish: z.strictObject({
      point: z
        .int()
        .min(0)
        .describe('Index into pointsM. The line crosses the track there, square to it.'),
    }),
    start: GroundPose.describe('Default start pose for worlds on this track.'),
  })
  .refine((track) => track.startFinish.point < track.centreline.pointsM.length, {
    path: ['startFinish', 'point'],
    message: 'startFinish.point must index a centreline point',
  });
export type Track = z.infer<typeof Track>;
