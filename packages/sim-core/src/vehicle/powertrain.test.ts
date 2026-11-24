import { defaultCatalog, exampleCar } from '@rcsim/schema';
import { describe, expect, it } from 'vitest';
import { vehicleParams } from './params.ts';
import { brakeTorqueNm, motorLoad } from './powertrain.ts';

const motor = vehicleParams({ car: exampleCar, catalog: defaultCatalog, physicsStage: 2 }).motor!;
const PACK = { openCircuitV: 7.4, resistanceOhm: 0.012 };
const STIFF = { openCircuitV: 7.4, resistanceOhm: 0 };
// stall current at 7.4 V = torque × Kv (rad/s/V); winding resistance follows
const STALL_A = 0.2 * ((2700 * 2 * Math.PI) / 60);
const WINDING_OHM = 7.4 / STALL_A;
const NO_LOAD_RAD_S = ((2700 * 2 * Math.PI) / 60) * 7.4;

describe('motor load', () => {
  it('draws nothing and does not sag at zero duty', () => {
    expect(motorLoad(motor, PACK, 0, 500)).toEqual({
      torqueNm: 0,
      packV: 7.4,
      packCurrentA: 0,
    });
  });

  it('gives the part its stall torque from a pack with no resistance', () => {
    const load = motorLoad(motor, STIFF, 1, 0);
    expect(load.torqueNm).toBeCloseTo(0.2, 9);
    expect(load.packCurrentA).toBeCloseTo(STALL_A, 9);
    expect(load.packV).toBe(7.4);
  });

  it('matches the stage-1 torque line at speed from a stiff pack', () => {
    const load = motorLoad(motor, STIFF, 0.6, 0.25 * NO_LOAD_RAD_S);
    expect(load.torqueNm).toBeCloseTo(0.2 * (0.6 - 0.25), 9);
  });

  it('sags the pack through its internal resistance at stall, and loses torque with it', () => {
    const load = motorLoad(motor, PACK, 1, 0);
    const amps = 7.4 / (WINDING_OHM + 0.012);
    expect(load.packCurrentA).toBeCloseTo(amps, 9);
    expect(load.packV).toBeCloseTo(7.4 - 0.012 * amps, 9);
    expect(load.torqueNm).toBeCloseTo((0.2 * amps) / STALL_A, 9);
  });

  it('takes duty × motor current from the pack under PWM', () => {
    const load = motorLoad(motor, PACK, 0.5, 0);
    const motorA = (0.5 * load.packV) / WINDING_OHM;
    expect(load.packCurrentA).toBeCloseTo(0.5 * motorA, 9);
    expect(load.packV).toBeCloseTo(7.4 - 0.012 * load.packCurrentA, 9);
  });

  it('sags less as the motor speeds up', () => {
    expect(motorLoad(motor, PACK, 1, 0.8 * NO_LOAD_RAD_S).packV).toBeGreaterThan(
      motorLoad(motor, PACK, 1, 0.2 * NO_LOAD_RAD_S).packV,
    );
  });

  it('is symmetric in reverse', () => {
    const back = motorLoad(motor, PACK, -1, 0);
    const forward = motorLoad(motor, PACK, 1, 0);
    expect(back.torqueNm).toBeCloseTo(-forward.torqueNm, 12);
    expect(back.packV).toBeCloseTo(forward.packV, 12);
  });

  it('does not charge the pack when the motor outruns its duty', () => {
    const load = motorLoad(motor, PACK, 0.2, NO_LOAD_RAD_S);
    expect(load.torqueNm).toBeLessThan(0);
    expect(load.packCurrentA).toBe(0);
    expect(load.packV).toBe(7.4);
  });

  it('draws more than stall current when driven against its rotation', () => {
    const plug = motorLoad(motor, PACK, -1, 0.5 * NO_LOAD_RAD_S);
    expect(plug.packCurrentA).toBeGreaterThan(motorLoad(motor, PACK, -1, 0).packCurrentA);
    expect(plug.torqueNm).toBeLessThan(0);
  });
});

describe('dynamic brake', () => {
  it('opposes the rotation in proportion to speed and strength', () => {
    const full = brakeTorqueNm(motor, 1, 400);
    expect(full).toBeGreaterThan(0); // a magnitude: the caller points it against the motion
    expect(brakeTorqueNm(motor, 0.5, 400)).toBeCloseTo(full / 2, 12);
    expect(brakeTorqueNm(motor, 1, -400)).toBeCloseTo(full, 12);
    expect(brakeTorqueNm(motor, 1, 0)).toBe(0);
    // the shorted motor at no-load speed brakes as hard as it stalls
    expect(brakeTorqueNm(motor, 1, NO_LOAD_RAD_S)).toBeCloseTo(0.2, 9);
  });
});
