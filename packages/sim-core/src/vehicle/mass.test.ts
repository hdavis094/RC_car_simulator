import { defaultCatalog, exampleCar } from '@rcsim/schema';
import { describe, expect, it } from 'vitest';
import { vehicleParams } from './params.ts';
import { BATTERY_KG, carWith } from './stage-two-test-support.ts';

const stage2 = (car = exampleCar) =>
  vehicleParams({ car, catalog: defaultCatalog, physicsStage: 2 });

/** The default chassis' own centre of gravity, metres. */
const CHASSIS_COG = [0, 0.1, 0.0335] as const;

describe('stage-1 mass', () => {
  it('keeps the chassis centre of gravity wherever the parts are', () => {
    const car = carWith({ battery: { mount: 'rear' } });
    for (const params of [
      vehicleParams({ car, catalog: defaultCatalog }),
      vehicleParams({ car, catalog: defaultCatalog, physicsStage: 1 }),
    ]) {
      expect(params.physicsStage).toBe(1);
      expect(params.cogM).toEqual([0, 0.1, 0.0335]);
    }
  });
});

describe('stage-2 centre of gravity', () => {
  it('weighs the same as stage 1', () => {
    const stage1 = vehicleParams({ car: exampleCar, catalog: defaultCatalog });
    expect(stage2().massKg).toBe(stage1.massKg);
  });

  it('moves toward a placed part in proportion to its mass', () => {
    const base = stage2();
    // rear mount: (0, 80, 270) mm
    const rear = stage2(carWith({ battery: { mount: 'rear' } }));
    const share = BATTERY_KG / base.massKg;
    // moving the battery from the chassis centre of gravity to the mount
    expect(rear.cogM[2] - base.cogM[2]).toBeCloseTo(share * (0.27 - CHASSIS_COG[2]), 9);
    expect(rear.cogM[1] - base.cogM[1]).toBeCloseTo(share * (0.08 - CHASSIS_COG[1]), 9);
    expect(rear.cogM[0]).toBeCloseTo(base.cogM[0], 9);
  });

  it('adds the placement offset to the mount position', () => {
    const at = stage2(carWith({ battery: { mount: 'rear' } }));
    const offset = stage2(
      carWith({ battery: { mount: 'rear', offsetMm: { x: 100, y: 20, z: -50 } } }),
    );
    const share = BATTERY_KG / at.massKg;
    expect(offset.cogM[0] - at.cogM[0]).toBeCloseTo(share * 0.1, 9);
    expect(offset.cogM[1] - at.cogM[1]).toBeCloseTo(share * 0.02, 9);
    expect(offset.cogM[2] - at.cogM[2]).toBeCloseTo(share * -0.05, 9);
  });

  it('leaves unplaced parts at the chassis centre of gravity', () => {
    const bare = {
      ...exampleCar,
      controller: { ...exampleCar.controller, placement: undefined },
      parts: exampleCar.parts.map((part) => ({ ...part, placement: undefined })),
    };
    const params = stage2(bare);
    CHASSIS_COG.forEach((v, i) => expect(params.cogM[i]).toBeCloseTo(v, 12));
  });

  it('raises the rotational inertia when mass is placed far from the middle', () => {
    const base = stage2();
    const spread = stage2(carWith({ battery: { mount: 'rear' } }));
    // yaw (about Y) and pitch (about X) both grow with fore-aft distance
    expect(spread.inertiaKgM2.y).toBeGreaterThan(base.inertiaKgM2.y);
    expect(spread.inertiaKgM2.x).toBeGreaterThan(base.inertiaKgM2.x);
  });

  it('refuses a physics stage it does not know', () => {
    expect(() =>
      vehicleParams({ car: exampleCar, catalog: defaultCatalog, physicsStage: 3 as 2 }),
    ).toThrow(/physics stage/);
  });
});

describe('stage-2 battery', () => {
  it("takes the pack's internal resistance from the catalog", () => {
    expect(stage2().batteryResistanceOhm).toBeCloseTo(0.012, 12);
  });

  it('has no sag without a battery part', () => {
    const car = {
      ...exampleCar,
      parts: exampleCar.parts.filter((part) => part.instanceId !== 'battery'),
    };
    expect(stage2(car).batteryResistanceOhm).toBe(0);
  });
});
