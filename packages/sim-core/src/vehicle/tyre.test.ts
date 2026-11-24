import { describe, expect, it } from 'vitest';
import { TYRE, tyreImpulse, type TyreContact } from './tyre.ts';

const DT = 0.001;
const LOAD = 6;
const GRIP = TYRE.friction * LOAD * DT;
const contact = (over: Partial<TyreContact>): TyreContact => ({
  loadN: LOAD,
  forwardMps: 0,
  rightMps: 0,
  driveN: 0,
  resistN: 0,
  forwardMassKg: 0.5,
  rightMassKg: 0.5,
  dtS: DT,
  ...over,
});

describe('lateral force', () => {
  it('opposes a sideways slip in proportion to a small slip angle', () => {
    const small = tyreImpulse(contact({ forwardMps: 2, rightMps: 0.02 }));
    expect(small.right).toBeCloseTo(-TYRE.corneringStiffness * LOAD * Math.atan2(0.02, 2) * DT, 12);
    expect(small.forward).toBeCloseTo(0, 12);
  });

  it('saturates at the friction limit however much the tyre slides', () => {
    for (const rightMps of [1, 3, 30]) {
      expect(tyreImpulse(contact({ forwardMps: 2, rightMps })).right).toBeCloseTo(-GRIP, 12);
      expect(tyreImpulse(contact({ forwardMps: 2, rightMps: -rightMps })).right).toBeCloseTo(
        GRIP,
        12,
      );
    }
  });

  it('never pushes a nearly still wheel back past rest', () => {
    const j = tyreImpulse(contact({ rightMps: 1e-4, dtS: 0.05 }));
    expect(j.right).toBeCloseTo(-1e-4 * 0.5, 12);
  });
});

describe('longitudinal force', () => {
  it('passes the drive force through while there is grip for it', () => {
    expect(tyreImpulse(contact({ driveN: 2 })).forward).toBeCloseTo(2 * DT, 12);
  });

  it('caps the drive force at the friction limit (wheelspin)', () => {
    expect(tyreImpulse(contact({ driveN: 50 })).forward).toBeCloseTo(GRIP, 12);
    expect(tyreImpulse(contact({ driveN: -50 })).forward).toBeCloseTo(-GRIP, 12);
  });

  it('resists motion without reversing it', () => {
    expect(tyreImpulse(contact({ forwardMps: 2, resistN: 3 })).forward).toBeCloseTo(-3 * DT, 12);
    expect(tyreImpulse(contact({ forwardMps: -2, resistN: 3 })).forward).toBeCloseTo(3 * DT, 12);
    expect(tyreImpulse(contact({ forwardMps: 1e-4, resistN: 3 })).forward).toBeCloseTo(
      -1e-4 * 0.5,
      12,
    );
    expect(tyreImpulse(contact({ resistN: 3 })).forward).toBeCloseTo(0, 12);
  });

  it('holds a still wheel against a drive force weaker than its resistance', () => {
    expect(tyreImpulse(contact({ driveN: 1, resistN: 3 })).forward).toBeCloseTo(0, 12);
  });

  it('caps a locked wheel at the friction limit', () => {
    expect(tyreImpulse(contact({ forwardMps: 3, resistN: 80 })).forward).toBeCloseTo(-GRIP, 12);
  });
});

describe('friction circle', () => {
  it('shares one grip limit between cornering and driving', () => {
    const j = tyreImpulse(contact({ forwardMps: 2, rightMps: 2, driveN: 50 }));
    expect(Math.hypot(j.forward, j.right)).toBeCloseTo(GRIP, 12);
    expect(j.forward).toBeGreaterThan(0);
    expect(j.right).toBeLessThan(0);
    // less cornering force than the same slide without throttle
    expect(Math.abs(j.right)).toBeLessThan(GRIP);
  });

  it('gives nothing without load', () => {
    const j = tyreImpulse(contact({ loadN: 0, forwardMps: 2, rightMps: 2, driveN: 5 }));
    expect(Math.hypot(j.forward, j.right)).toBe(0);
  });
});
