import { z } from 'zod';
import { JsonSchemaRef, SchemaVersion } from './common.ts';

/** A point on the ground plane in metres: +X right, −Z forward of the world origin. */
export const GroundPointM = z.strictObject({ x: z.number(), z: z.number() });
export type GroundPointM = z.infer<typeof GroundPointM>;

/** A position and heading on the ground. Yaw 0 faces −Z; positive turns left. */
export const GroundPose = z.strictObject({
  positionM: GroundPointM,
  yawDeg: z.number(),
});
export type GroundPose = z.infer<typeof GroundPose>;

export const ObstacleType = z.enum(['cone', 'box', 'wall', 'ramp']);
export type ObstacleType = z.infer<typeof ObstacleType>;

export const Obstacle = z.strictObject({
  id: z.string().min(1).optional().describe('Stable id for editing; unique within the world.'),
  type: ObstacleType,
  positionM: GroundPointM,
  yawDeg: z.number(),
});
export type Obstacle = z.infer<typeof Obstacle>;

/** worlds/*.json: a track, a layout of obstacles, a start pose and a seed. */
export const World = z
  .strictObject({
    $schema: JsonSchemaRef,
    schemaVersion: SchemaVersion,
    name: z.string().min(1),
    trackId: z.string().regex(/^[a-z][a-z0-9-]*$/, 'a track id is kebab-case, like "oval"'),
    start: GroundPose.optional().describe("Defaults to the track's start pose."),
    seed: z.int().min(0).max(0xffff_ffff).describe('Fixes all randomness in a run.'),
    obstacles: z.array(Obstacle),
  })
  .superRefine((world, ctx) => {
    const ids = new Set<string>();
    world.obstacles.forEach((obstacle, i) => {
      if (obstacle.id === undefined) return;
      if (ids.has(obstacle.id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['obstacles', i, 'id'],
          message: `obstacle id "${obstacle.id}" is used twice`,
        });
      }
      ids.add(obstacle.id);
    });
  });
export type World = z.infer<typeof World>;
