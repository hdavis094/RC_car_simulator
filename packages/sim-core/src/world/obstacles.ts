import type { ObstacleType } from '@rcsim/schema';
import type { Rapier } from './rapier.ts';
import { GROUP, groups } from './rapier.ts';
import type { ColliderDesc } from '@dimforge/rapier3d-deterministic-compat';

/**
 * Obstacle sizes, metres, for a 1/10 car. The obstacle's position is on the
 * ground at its centre; yaw 0 faces −Z, so a `wall` or `ramp` at yaw 0 is
 * crossed by a car heading −Z (the ramp rises toward −Z).
 */
export const OBSTACLE_SIZES = {
  cone: { radius: 0.06, height: 0.25 },
  box: { half: 0.15 },
  wall: { halfLength: 0.5, halfHeight: 0.1, halfThickness: 0.025 },
  ramp: { halfWidth: 0.25, halfLength: 0.4, height: 0.08 },
} as const;

/** The collider for an obstacle, positioned relative to its ground point. */
export function obstacleCollider(rapier: Rapier, type: ObstacleType): ColliderDesc {
  const g = (membership: number) => groups(membership, 0xffff);
  switch (type) {
    case 'cone': {
      const { radius, height } = OBSTACLE_SIZES.cone;
      return rapier.ColliderDesc.cone(height / 2, radius)
        .setTranslation(0, height / 2, 0)
        .setCollisionGroups(g(GROUP.solid));
    }
    case 'box': {
      const { half } = OBSTACLE_SIZES.box;
      return rapier.ColliderDesc.cuboid(half, half, half)
        .setTranslation(0, half, 0)
        .setCollisionGroups(g(GROUP.solid));
    }
    case 'wall': {
      const { halfLength, halfHeight, halfThickness } = OBSTACLE_SIZES.wall;
      return rapier.ColliderDesc.cuboid(halfLength, halfHeight, halfThickness)
        .setTranslation(0, halfHeight, 0)
        .setCollisionGroups(g(GROUP.solid));
    }
    case 'ramp': {
      const { halfWidth: w, halfLength: l, height: h } = OBSTACLE_SIZES.ramp;
      // A wedge: low edge at +Z, high edge at −Z. In the ground group so the
      // wheels' suspension rays find it.
      const hull = rapier.ColliderDesc.convexHull(
        new Float32Array([-w, 0, l, w, 0, l, -w, 0, -l, w, 0, -l, -w, h, -l, w, h, -l]),
      );
      if (!hull) throw new Error('could not build the ramp collider');
      return hull.setCollisionGroups(g(GROUP.ground));
    }
  }
}
