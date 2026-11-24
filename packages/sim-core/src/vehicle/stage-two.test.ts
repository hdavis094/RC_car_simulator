import { describe, expect, it } from 'vitest';
import { rotate } from '../world/quat.ts';
import { carWith, openFloor, type Floor } from './stage-two-test-support.ts';
import { TYRE } from './tyre.ts';

const G = 9.81;
const MAX_STEER = (28 * Math.PI) / 180;
const WHEELBASE = 0.335;
const WALKING_DUTY = 0.2;
const brake = { motorDuty: -1, brake: true };
/** The hardest the tyres can push the car, m/s². */
const GRIP_MPS2 = TYRE.friction * G;

const horizontalSpeed = ({ car }: Floor): number => {
  const [x, , z] = car.state().velocity;
  return Math.hypot(x, z);
};
const upright = ({ car }: Floor): number => rotate(car.state().pose.rotation, [0, 1, 0])[1];

describe('stage-2 vehicle at low speed', () => {
  for (const tickUs of [1000, 20_000]) {
    it(`stands still on its wheels (${tickUs / 1000} ms ticks)`, async () => {
      const floor = await openFloor({ tickUs });
      floor.drive(3);
      const s = floor.car.state();
      expect(s.wheels.every((w) => w.inContact)).toBe(true);
      expect(s.pose.position[1]).toBeCloseTo(0, 2);
      // horizontal: at long ticks Rapier reports a steady vertical offset while the car is still
      expect(horizontalSpeed(floor)).toBeLessThan(0.005);
      expect(Math.hypot(s.pose.position[0], s.pose.position[2])).toBeLessThan(0.005);
    });

    it(`drives straight ahead and back (${tickUs / 1000} ms ticks)`, async () => {
      const floor = await openFloor({ tickUs });
      floor.drive(3, { motorDuty: WALKING_DUTY });
      expect(floor.car.state().forwardSpeedMps).toBeGreaterThan(1);
      expect(floor.car.state().forwardSpeedMps).toBeLessThan(1.8);
      expect(Math.abs(floor.car.state().pose.position[0])).toBeLessThan(0.05);
      floor.drive(4, { motorDuty: -WALKING_DUTY });
      expect(floor.car.state().forwardSpeedMps).toBeLessThan(-1);
    });
  }

  it('coasts to a stop at zero duty', async () => {
    const floor = await openFloor();
    floor.drive(3, { motorDuty: WALKING_DUTY });
    floor.drive(6);
    expect(horizontalSpeed(floor)).toBeLessThan(0.02);
  });

  for (const direction of [1, -1]) {
    it(`follows the steering geometry at walking pace (${direction > 0 ? 'left' : 'right'})`, async () => {
      const floor = await openFloor();
      const command = { steerAngleRad: direction * MAX_STEER, motorDuty: WALKING_DUTY };
      floor.drive(5, command);
      const radius = horizontalSpeed(floor) / (direction * floor.car.state().angularVelocity[1]);
      const kinematic = WHEELBASE / Math.tan(MAX_STEER);
      expect(radius).toBeGreaterThan(kinematic * 0.85);
      expect(radius).toBeLessThan(kinematic * 1.25);
    });
  }
});

describe('grip and slip', () => {
  it('limits a full-throttle launch to what the driven tyres can push', async () => {
    const grip = await openFloor();
    const arcade = await openFloor({ physicsStage: 1 });
    for (const floor of [grip, arcade]) {
      floor.drive(1);
      floor.drive(0.25, { motorDuty: 1 });
    }
    // rear drive: never more than μ × g, even with all the weight on the back
    expect(horizontalSpeed(grip) / 0.25).toBeLessThan(GRIP_MPS2);
    expect(horizontalSpeed(grip) / 0.25).toBeGreaterThan(GRIP_MPS2 * 0.35);
    expect(horizontalSpeed(grip)).toBeLessThan(horizontalSpeed(arcade));
  });

  it('slows a sideways slide no faster than friction allows', async () => {
    const floor = await openFloor();
    floor.drive(1);
    floor.car.body.setLinvel({ x: 3, y: 0, z: 0 }, true);
    floor.drive(0.1);
    const speed = horizontalSpeed(floor);
    expect(speed).toBeLessThan(3 - GRIP_MPS2 * 0.1 * 0.7);
    expect(speed).toBeGreaterThan(3 - GRIP_MPS2 * 0.1 * 1.1);
    expect(upright(floor)).toBeGreaterThan(0.9);
  });

  it('slips wide when a fast turn asks for more than the tyres have', async () => {
    const floor = await openFloor();
    floor.drive(4, { motorDuty: 0.7 });
    const turn = { steerAngleRad: MAX_STEER, motorDuty: 0.7 };
    floor.drive(0.5, turn);
    let frontSlipRad = 0;
    for (let i = 0; i < 20; i++) {
      const before = floor.car.state().velocity;
      floor.drive(0.1, turn);
      const { velocity, pose } = floor.car.state();
      // the change of the whole velocity over 100 ms is what the tyres supplied
      const accel = Math.hypot(velocity[0] - before[0], velocity[2] - before[2]) / 0.1;
      expect(accel).toBeLessThan(GRIP_MPS2 * 1.05);
      // the front-left tyre: its velocity against where it points
      const { angularVelocity: spin, wheels } = floor.car.state();
      const front = wheels[0].position;
      const com = floor.car.body.worldCom();
      const [rx, rz] = [front[0] - com.x, front[2] - com.z];
      const moving = [velocity[0] + spin[1] * rz, velocity[2] - spin[1] * rx] as const;
      const pointing = rotate(pose.rotation, [
        -Math.sin(wheels[0].steerRad),
        0,
        -Math.cos(wheels[0].steerRad),
      ]);
      const along = moving[0] * pointing[0] + moving[1] * pointing[2];
      frontSlipRad = Math.max(frontSlipRad, Math.acos(along / Math.hypot(...moving)));
    }
    const radius = horizontalSpeed(floor) / Math.abs(floor.car.state().angularVelocity[1]);
    expect(radius).toBeGreaterThan((2 * WHEELBASE) / Math.tan(MAX_STEER));
    // past the angle at which the tyre's force stops growing
    expect(frontSlipRad).toBeGreaterThan(TYRE.friction / TYRE.corneringStiffness);
    expect(upright(floor)).toBeGreaterThan(0.9);
  });
});

describe('centre of gravity', () => {
  it('puts more load, and so more traction, on the rear when the battery moves back', async () => {
    const speeds: number[] = [];
    for (const mount of ['front-centre', 'rear']) {
      const floor = await openFloor({ car: carWith({ battery: { mount } }) });
      floor.drive(1);
      floor.drive(0.25, { motorDuty: 1 });
      speeds.push(horizontalSpeed(floor));
    }
    const [front, rear] = speeds as [number, number];
    expect(rear).toBeGreaterThan(front * 1.05);
  });

  it('keeps the chassis frame on the ground wherever the mass is', async () => {
    const floor = await openFloor({
      car: carWith({ battery: { mount: 'rear', offsetMm: { x: 100, y: 0, z: 0 } } }),
    });
    floor.drive(2);
    const s = floor.car.state();
    expect(s.pose.position[1]).toBeCloseTo(0, 2);
    expect(upright(floor)).toBeGreaterThan(0.999);
    expect(s.wheels.every((w) => w.inContact)).toBe(true);
  });
});

describe('braking', () => {
  it('stops sooner than coasting and never drives the car backwards', async () => {
    const braked = await openFloor();
    const coasting = await openFloor();
    for (const floor of [braked, coasting]) floor.drive(3, { motorDuty: 0.4 });
    braked.drive(0.4, brake);
    coasting.drive(0.4);
    expect(braked.car.state().forwardSpeedMps).toBeLessThan(
      coasting.car.state().forwardSpeedMps * 0.7,
    );
    let slowest = Infinity;
    for (let i = 0; i < 60; i++) {
      braked.drive(0.1, brake);
      slowest = Math.min(slowest, braked.car.state().forwardSpeedMps);
    }
    expect(slowest).toBeGreaterThan(-0.01);
    expect(horizontalSpeed(braked)).toBeLessThan(0.02);
    expect(braked.car.state().command).toEqual({ steerAngleRad: 0, motorDuty: -1, brake: true });
  });

  it('never moves a standing car', async () => {
    const floor = await openFloor();
    floor.drive(2, brake);
    expect(horizontalSpeed(floor)).toBeLessThan(0.005);
  });
});

describe('battery sag', () => {
  it('drops the pack voltage under motor load and recovers without it', async () => {
    const floor = await openFloor();
    expect(floor.car.packVolts).toBe(7.4);
    floor.drive(0.5);
    expect(floor.car.packVolts).toBe(7.4);
    floor.drive(0.01, { motorDuty: 1 });
    const launching = floor.car.packVolts;
    expect(launching).toBeLessThan(7.4 - 0.4);
    expect(launching).toBeGreaterThan(6);
    floor.drive(4, { motorDuty: 1 });
    expect(floor.car.packVolts).toBeGreaterThan(launching); // back-EMF cuts the current
    expect(floor.car.packVolts).toBeLessThan(7.4);
    floor.drive(0.01);
    expect(floor.car.packVolts).toBe(7.4);
  });

  it('does not load the pack while braking', async () => {
    const floor = await openFloor();
    floor.drive(2, { motorDuty: 0.4 });
    floor.drive(0.01, brake);
    expect(floor.car.packVolts).toBe(7.4);
  });

  it('stays at the nominal voltage in stage 1', async () => {
    const floor = await openFloor({ physicsStage: 1 });
    floor.drive(0.5, { motorDuty: 1 });
    expect(floor.car.packVolts).toBe(7.4);
  });
});
