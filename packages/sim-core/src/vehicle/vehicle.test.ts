import { defaultCatalog, exampleCar, World } from '@rcsim/schema';
import { describe, expect, it } from 'vitest';
import type { Vehicle, VehicleCommand } from '../api/vehicle.ts';
import type { World as SimWorld } from '../api/world.ts';
import { quatMul, quatY, rotate, yawOf } from '../world/quat.ts';
import { createWorld } from '../world/world.ts';
import { trackLibrary } from '../world/track-library.ts';
import { vehicleParams } from './params.ts';

const WHEELBASE = 0.335;
const TRACK_WIDTH = 0.24;
const MAX_STEER = (28 * Math.PI) / 180;
/** Motor duty that holds about 1.4 m/s: a brisk walking pace. */
const WALKING_DUTY = 0.2;

async function openFloor(
  start = { x: 0, z: 0, yawDeg: 0 },
): Promise<{ world: SimWorld; car: Vehicle; step: (n: number, c: VehicleCommand) => void }> {
  const track = { ...trackLibrary.load('oval'), wallHeightM: 0 };
  const file = World.parse({
    schemaVersion: 1,
    name: 'floor',
    trackId: 'oval',
    seed: 1,
    obstacles: [],
    start: { positionM: { x: start.x, z: start.z }, yawDeg: start.yawDeg },
  });
  const world = await createWorld(file, track);
  const car = world.createVehicle({ car: exampleCar, catalog: defaultCatalog });
  let tick = 0;
  return {
    world,
    car,
    step(n, command) {
      for (let i = 0; i < n; i++) {
        car.applyCommand(command);
        world.step(0.001, ++tick * 1000);
      }
    },
  };
}

/** Least-squares circle through points (Kåsa fit): returns the radius. */
function fitRadius(points: readonly (readonly [number, number])[]): number {
  const n = points.length;
  let sx = 0,
    sz = 0,
    sxx = 0,
    szz = 0,
    sxz = 0,
    sr = 0,
    sxr = 0,
    szr = 0;
  for (const [x, z] of points) {
    const r = x * x + z * z;
    sx += x;
    sz += z;
    sxx += x * x;
    szz += z * z;
    sxz += x * z;
    sr += r;
    sxr += x * r;
    szr += z * r;
  }
  // Solve [sxx sxz sx; sxz szz sz; sx sz n] [a b c]^T = [sxr szr sr]^T for x² + z² = a x + b z + c.
  const m = [
    [sxx, sxz, sx, sxr],
    [sxz, szz, sz, szr],
    [sx, sz, n, sr],
  ];
  for (let i = 0; i < 3; i++) {
    let pivot = i;
    for (let r = i + 1; r < 3; r++) if (Math.abs(m[r]![i]!) > Math.abs(m[pivot]![i]!)) pivot = r;
    [m[i], m[pivot]] = [m[pivot]!, m[i]!];
    for (let r = i + 1; r < 3; r++) {
      const f = m[r]![i]! / m[i]![i]!;
      for (let c = i; c < 4; c++) m[r]![c]! -= f * m[i]![c]!;
    }
  }
  const sol = [0, 0, 0];
  for (let i = 2; i >= 0; i--) {
    let v = m[i]![3]!;
    for (let c = i + 1; c < 3; c++) v -= m[i]![c]! * sol[c]!;
    sol[i] = v / m[i]![i]!;
  }
  const [a, b, c] = sol as [number, number, number];
  return Math.sqrt(c + (a / 2) ** 2 + (b / 2) ** 2);
}

describe('vehicle parameters', () => {
  it('builds the car from the chassis and its parts', () => {
    const p = vehicleParams({ car: exampleCar, catalog: defaultCatalog });
    expect(p.wheelbaseM).toBeCloseTo(0.335);
    expect(p.trackWidthM).toBeCloseTo(0.24);
    expect(p.wheelRadiusM).toBeCloseTo(0.055);
    expect(p.maxSteerRad).toBeCloseTo(MAX_STEER);
    expect(p.driveWheels).toBe('rear');
    // the chassis alone is 1.79 kg; the parts on it add to that
    expect(p.massKg).toBeGreaterThan(1.79);
    expect(p.cogM[1]).toBeCloseTo(0.1);
    expect(p.motor?.stallTorqueNm).toBeCloseTo(0.2);
    expect(p.batteryV).toBeCloseTo(7.4);
  });
});

describe('vehicle at rest', () => {
  it('settles on its wheels with the chassis frame on the ground', async () => {
    const { car, step } = await openFloor({ x: 1, z: 2, yawDeg: 0 });
    step(1500, { steerAngleRad: 0, motorDuty: 0 });
    const s = car.state();
    expect(s.pose.position[0]).toBeCloseTo(1, 2);
    expect(s.pose.position[1]).toBeCloseTo(0, 2);
    expect(s.pose.position[2]).toBeCloseTo(2, 2);
    expect(s.wheels.every((w) => w.inContact)).toBe(true);
    expect(Math.hypot(...s.velocity)).toBeLessThan(0.01);
    // wheel centres sit one wheel radius up, at the four corners, front = −Z, left = −X
    const [fl, fr, rl, rr] = s.wheels;
    expect(fl.position[0]).toBeCloseTo(1 - TRACK_WIDTH / 2, 2);
    expect(fr.position[0]).toBeCloseTo(1 + TRACK_WIDTH / 2, 2);
    expect(fl.position[2]).toBeCloseTo(2 - WHEELBASE / 2, 2);
    expect(rl.position[2]).toBeCloseTo(2 + WHEELBASE / 2, 2);
    expect(rr.position[1]).toBeCloseTo(0.055, 2);
  });
});

describe('driving', () => {
  it('moves toward −Z at yaw 0 for positive duty, with positive forward speed', async () => {
    const { car, step } = await openFloor();
    step(3000, { steerAngleRad: 0, motorDuty: WALKING_DUTY });
    const s = car.state();
    expect(s.pose.position[2]).toBeLessThan(-1);
    expect(Math.abs(s.pose.position[0])).toBeLessThan(0.02);
    expect(s.forwardSpeedMps).toBeGreaterThan(1);
    expect(s.forwardSpeedMps).toBeLessThan(1.8);
    expect(s.wheels.every((w) => w.spinRad > 0)).toBe(true);
  });

  it('runs backwards for negative duty', async () => {
    const { car, step } = await openFloor();
    step(2000, { steerAngleRad: 0, motorDuty: -WALKING_DUTY });
    expect(car.state().forwardSpeedMps).toBeLessThan(-0.5);
    expect(car.state().pose.position[2]).toBeGreaterThan(0.5);
  });

  it('coasts to a stop at zero duty', async () => {
    const { car, step } = await openFloor();
    step(3000, { steerAngleRad: 0, motorDuty: WALKING_DUTY });
    step(6000, { steerAngleRad: 0, motorDuty: 0 });
    expect(Math.abs(car.state().forwardSpeedMps)).toBeLessThan(0.02);
  });

  it('reaches a top speed set by the motor, not unbounded', async () => {
    const { car, step } = await openFloor();
    step(8000, { steerAngleRad: 0, motorDuty: 1 });
    const speed = car.state().forwardSpeedMps;
    // No-load wheel speed: Kv × V / ratio × wheel radius = 7.5 m/s
    expect(speed).toBeGreaterThan(4);
    expect(speed).toBeLessThan(7.6);
  });

  it('turns left for positive steering angles (yaw rate positive)', async () => {
    const { car, step } = await openFloor();
    step(3000, { steerAngleRad: 0.2, motorDuty: WALKING_DUTY });
    expect(car.state().angularVelocity[1]).toBeGreaterThan(0.5);
    expect(yawOf(car.state().pose.rotation)).toBeGreaterThan(0.5);
  });

  it('turns right for negative steering angles', async () => {
    const { car, step } = await openFloor();
    step(3000, { steerAngleRad: -0.2, motorDuty: WALKING_DUTY });
    expect(car.state().angularVelocity[1]).toBeLessThan(-0.5);
  });

  it('clamps the command to the chassis limits', async () => {
    const { car, step } = await openFloor();
    step(10, { steerAngleRad: 3, motorDuty: 5 });
    const { command } = car.state();
    expect(command.steerAngleRad).toBeCloseTo(MAX_STEER);
    expect(command.motorDuty).toBe(1);
  });
});

describe('steering', () => {
  for (const direction of [1, -1]) {
    it(`turns within ±10% of wheelbase / tan(maxSteer) at full lock and walking pace (${direction > 0 ? 'left' : 'right'})`, async () => {
      const { car, step } = await openFloor();
      const command = { steerAngleRad: direction * MAX_STEER, motorDuty: WALKING_DUTY };
      step(4000, command); // settle into the turn
      // The rear-axle centre is what the bicycle model's radius describes.
      const rear: [number, number][] = [];
      for (let i = 0; i < 40; i++) {
        step(100, command);
        const { pose } = car.state();
        const back = rotate(pose.rotation, [0, 0, WHEELBASE / 2]);
        rear.push([pose.position[0] + back[0], pose.position[2] + back[2]]);
      }
      const speed = car.state().forwardSpeedMps;
      expect(speed).toBeGreaterThan(1);
      expect(speed).toBeLessThan(1.8);
      const radius = fitRadius(rear);
      const expected = WHEELBASE / Math.tan(MAX_STEER);
      expect(radius).toBeGreaterThan(expected * 0.9);
      expect(radius).toBeLessThan(expected * 1.1);
    });
  }

  it('steers the inner front wheel more than the outer (Ackermann)', async () => {
    const { car, step } = await openFloor();
    step(200, { steerAngleRad: MAX_STEER, motorDuty: 0 });
    const [fl, fr, rl, rr] = car.state().wheels;
    const radius = WHEELBASE / Math.tan(MAX_STEER);
    expect(Math.tan(fl.steerRad)).toBeCloseTo(WHEELBASE / (radius - TRACK_WIDTH / 2), 6);
    expect(Math.tan(fr.steerRad)).toBeCloseTo(WHEELBASE / (radius + TRACK_WIDTH / 2), 6);
    expect(fl.steerRad).toBeGreaterThan(fr.steerRad);
    expect(rl.steerRad).toBe(0);
    expect(rr.steerRad).toBe(0);
    // each wheel's world rotation carries the chassis, the steering and the spin
    const yawOfWheel = yawOf(fl.rotation);
    expect(yawOfWheel).toBeCloseTo(fl.steerRad, 2);
  });
});

describe('chassisToWorld', () => {
  it('places a point on the chassis, facing forward by default', async () => {
    const { car, step } = await openFloor({ x: 1, z: 0, yawDeg: 0 });
    step(1000, { steerAngleRad: 0, motorDuty: 0 });
    const pose = car.chassisToWorld([0, 0.06, -0.27], 0, 0);
    expect(pose.position[0]).toBeCloseTo(1, 2);
    expect(pose.position[1]).toBeCloseTo(0.06, 2);
    expect(pose.position[2]).toBeCloseTo(-0.27, 2);
    const forward = rotate(pose.rotation, [0, 0, -1]);
    expect(forward[2]).toBeCloseTo(-1, 3);
  });

  it('follows the car when it is rotated, and applies placement yaw and pitch', async () => {
    const { car, step } = await openFloor({ x: 0, z: 0, yawDeg: 90 });
    step(1000, { steerAngleRad: 0, motorDuty: 0 });
    // yaw 90° faces −X, so a point 0.27 m ahead is at x ≈ −0.27
    const ahead = car.chassisToWorld([0, 0, -0.27], 0, 0);
    expect(ahead.position[0]).toBeCloseTo(-0.27, 2);
    expect(ahead.position[2]).toBeCloseTo(0, 2);
    // a mount yawed 30° left, pitched 10° up
    const mount = car.chassisToWorld([0, 0, 0], (30 * Math.PI) / 180, (10 * Math.PI) / 180);
    const expected = quatMul(quatMul(quatY(Math.PI / 2), quatY(Math.PI / 6)), [
      Math.sin(Math.PI / 36),
      0,
      0,
      Math.cos(Math.PI / 36),
    ]);
    for (let i = 0; i < 4; i++) expect(mount.rotation[i]).toBeCloseTo(expected[i]!, 3);
  });
});
