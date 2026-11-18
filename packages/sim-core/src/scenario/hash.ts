import { createHash } from 'node:crypto';
import type { StateSnapshot } from '../api/snapshot.ts';

/**
 * SHA-256 of a snapshot's JSON. JSON prints a double as its shortest
 * round-trip digits, so equal hashes mean bit-identical numbers; `-0` is
 * spelled out because JSON would print it as `0`.
 */
export function snapshotHash(snapshot: StateSnapshot): string {
  const text = JSON.stringify(snapshot, (_key, value: unknown) =>
    Object.is(value, -0) ? '-0' : value,
  );
  return createHash('sha256').update(text).digest('hex');
}
