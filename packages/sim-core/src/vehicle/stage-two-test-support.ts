// Helpers shared by the stage-2 tests. Not part of the package's public API.
import { Car, World, defaultCatalog, exampleCar, type Placement } from '@rcsim/schema';
import type { PhysicsStage, VehicleCommand } from '../api/vehicle.ts';
import { trackLibrary } from '../world/track-library.ts';
import { createPhysicsWorld } from '../world/world.ts';
import type { RapierVehicle } from './vehicle.ts';

/** The default car with some parts placed (or re-placed) on the chassis. */
export function carWith(placements: Readonly<Record<string, Placement>>): Car {
  return Car.parse({
    ...exampleCar,
    parts: exampleCar.parts.map((part) => {
      const placement = placements[part.instanceId];
      return placement ? { ...part, placement } : part;
    }),
  });
}

/** Battery mass of the default catalog's pack, kg. */
export const BATTERY_KG = (defaultCatalog.get('power.lipo-2s-5000')?.massG ?? 0) / 1000;

export interface Floor {
  readonly car: RapierVehicle;
  /** Applies `command` for `seconds` of sim time. */
  drive(seconds: number, command?: Partial<VehicleCommand>): void;
}

/** A car at the middle of an open floor, facing −Z. */
export async function openFloor(
  options: { car?: Car; physicsStage?: PhysicsStage; tickUs?: number } = {},
): Promise<Floor> {
  const world = await createPhysicsWorld(
    World.parse({
      schemaVersion: 1,
      name: 'floor',
      trackId: 'oval',
      seed: 1,
      obstacles: [],
      start: { positionM: { x: 0, z: 0 }, yawDeg: 0 },
    }),
    { ...trackLibrary.load('oval'), wallHeightM: 0 },
  );
  const car = world.createVehicle({
    car: options.car ?? exampleCar,
    catalog: defaultCatalog,
    physicsStage: options.physicsStage ?? 2,
  });
  const tickUs = options.tickUs ?? 1000;
  let nowUs = 0;
  return {
    car,
    drive(seconds, command = {}) {
      for (let i = 0; i < Math.round((seconds * 1_000_000) / tickUs); i++) {
        car.applyCommand({ steerAngleRad: 0, motorDuty: 0, ...command });
        nowUs += tickUs;
        world.step(tickUs / 1_000_000, nowUs);
      }
    },
  };
}
