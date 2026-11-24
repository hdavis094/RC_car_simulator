import { describe, expect, it } from 'vitest';
import { runNetworkDropout } from './network-dropout.ts';

describe('the network-dropout scenario', () => {
  it('applies manual driving before dropout and neutralizes via the 500 ms failsafe in deterministic sim time', async () => {
    const first = await runNetworkDropout({ seed: 1 });
    const { scenario, trace } = first;

    expect(scenario.end).toEqual({ kind: 'stopped' });
    expect(scenario.passed).toBe(true);
    expect(scenario.metrics.collisions).toBe(0);
    expect(scenario.metrics.distanceM).toBeGreaterThan(0.5);
    expect(scenario.metrics.maxSpeedMps).toBeGreaterThan(0.5);

    // Pre-dropout held drive stream (throttle 0.28 -> 1640 µs, steer -0.05 -> 1475 µs) is applied.
    expect(trace.escPulseBeforeDropoutUs).toBe(1640);
    expect(trace.steerPulseBeforeDropoutUs).toBe(1475);

    // 400 ms after dropout starts (4.41 s, < 500 ms after the 4.00 s drive command), drive is still active.
    expect(trace.escPulseMidWindowUs).toBe(1640);
    expect(trace.steerPulseMidWindowUs).toBe(1475);

    // Manual failsafe trips right after 500 ms of sim time since the last received drive command (4.00 s).
    expect(trace.failsafeNeutralAtUs).not.toBeNull();
    expect(trace.failsafeNeutralAtUs!).toBeGreaterThanOrEqual(4_500_000);
    expect(trace.failsafeNeutralAtUs!).toBeLessThanOrEqual(4_510_000);

    expect(trace.failsafeLoggedAtUs).not.toBeNull();
    expect(trace.failsafeLoggedAtUs!).toBeGreaterThanOrEqual(4_500_000);
    expect(trace.failsafeLoggedAtUs!).toBeLessThanOrEqual(4_510_000);

    // Both ESC and steering stay neutral for the remainder of the dropout despite continuing drive commands.
    expect(trace.finalEscPulseUs).toBe(1500);
    expect(trace.finalSteerPulseUs).toBe(1500);
    expect(trace.postFailsafeMaxEscDeltaUs).toBe(0);
    expect(trace.postFailsafeMaxSteerDeltaUs).toBe(0);

    // Repeatability with the same seed and sim timing.
    const second = await runNetworkDropout({ seed: 1 });
    expect(second.trace).toEqual(trace);
    expect(second.scenario.serialHash).toBe(scenario.serialHash);
    expect(second.scenario.snapshotHash).toBe(scenario.snapshotHash);
  }, 120_000);
});
