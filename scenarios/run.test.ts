import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { fingerprint, runV1, type V1Fingerprint } from './run.ts';

const expected = JSON.parse(
  readFileSync(new URL('v1.expected.json', import.meta.url), 'utf8'),
) as V1Fingerprint;

describe('the v1 scenario', () => {
  it('drives the cone oval with the starter firmware and matches the recorded result', async () => {
    const result = await runV1({ seed: 1 });

    expect(result.end).toEqual({ kind: 'stopped' });
    expect(result.assertions.map((a) => [a.metric, a.passed])).toEqual([
      ['collisions', true],
      ['laps', true],
    ]);
    expect(result.passed).toBe(true);
    // The cross-platform gate: Linux and macOS must record the same run.
    expect(fingerprint(result)).toEqual(expected);
  }, 120_000);
});
