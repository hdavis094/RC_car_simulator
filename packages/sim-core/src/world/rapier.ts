import RAPIER from '@dimforge/rapier3d-deterministic-compat';

/** The Rapier module, once its WebAssembly has been initialised. */
export type Rapier = typeof RAPIER;

let loading: Promise<Rapier> | undefined;

/**
 * Loads Rapier's deterministic WebAssembly build (once per process). The
 * `-compat` build embeds the wasm, so it needs no file access and the same
 * code runs in Node, the sim host and the CLI.
 */
export function loadRapier(): Promise<Rapier> {
  loading ??= RAPIER.init().then(() => RAPIER);
  return loading;
}

/**
 * Rapier interaction groups: memberships in the high 16 bits, the groups a
 * collider interacts with in the low 16. Queries use the same encoding.
 */
export const GROUP = {
  /** The ground and ramps: what the wheels' suspension rays look for. */
  ground: 0x0001,
  /** Walls, cones, boxes and barriers. */
  solid: 0x0002,
  /** The car's body. */
  vehicle: 0x0004,
} as const;

export function groups(memberships: number, filter: number): number {
  return (((memberships & 0xffff) << 16) | (filter & 0xffff)) >>> 0;
}
