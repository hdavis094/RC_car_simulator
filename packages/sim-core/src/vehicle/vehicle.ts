import type {
  Collider,
  DynamicRayCastVehicleController,
  RigidBody,
  World as RapierWorld,
} from '@dimforge/rapier3d-deterministic-compat';
import type { Pose, Quat, Vec3 } from '../api/math.ts';
import {
  WHEEL_ORDER,
  type Vehicle,
  type VehicleCommand,
  type VehicleState,
  type WheelState,
} from '../api/vehicle.ts';
import { GROUP, groups, type Rapier } from '../world/rapier.ts';
import { quatMul, quatX, quatY, rotate } from '../world/quat.ts';
import type { VehicleParams } from './params.ts';
import { brakeTorqueNm, motorLoad } from './powertrain.ts';
import { tyreImpulse } from './tyre.ts';

const GRAVITY = 9.81;

/** Suspension and tyre tuning for a 1/10 car (stage 1: arcade-believable, not measured). */
const TUNING = {
  restLengthM: 0.03,
  maxTravelM: 0.03,
  /** Spring rate per unit of car mass: Rapier scales suspension force by the chassis mass. */
  stiffness: 200,
  compressionDamping: 10,
  relaxationDamping: 12,
  maxSuspensionForceN: 2000,
  /** Peak tyre force as a multiple of the wheel's load (a grippy rubber-on-smooth-floor μ). */
  frictionSlip: 1.5,
  sideFrictionStiffness: 1,
  /** Rolling resistance, as a fraction of the car's weight. */
  rollingResistance: 0.08,
  /** Underside of the body above the ground, metres. */
  bodyClearanceM: 0.04,
  bodyFriction: 0.2,
} as const;

export interface VehicleStart {
  readonly x: number;
  readonly z: number;
  readonly yawDeg: number;
}

const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/**
 * The car: a rigid body with a Rapier ray-cast vehicle controller for the
 * four wheels. Ackermann steering on the front wheels, a DC-motor model
 * (stall torque, back-EMF) driving the driven wheels through the final drive.
 *
 * Stage 1 leaves the tyres to Rapier's controller. Stage 2 (docs/PHYSICS.md)
 * uses the controller for the suspension alone and applies its own bounded
 * tyre impulses, with the motor fed by a pack that sags under load.
 */
export class RapierVehicle implements Vehicle {
  readonly body: RigidBody;
  readonly collider: Collider;
  readonly params: VehicleParams;

  readonly #controller: DynamicRayCastVehicleController;
  readonly #cog: Vec3;
  readonly #driven: readonly number[];
  readonly #loadN: readonly number[];
  /** Wheel centres in the chassis frame with the car at rest on flat ground. */
  readonly #wheelRest: readonly Vec3[];
  /** Each wheel's suspension hard point in the body (centre-of-gravity) frame. */
  readonly #hardPoints: Vec3[] = [];
  /** False until the suspension has first been queried (`beforeStep`): its hard points are unset before. */
  #queried = false;
  #command: VehicleCommand = { steerAngleRad: 0, motorDuty: 0 };
  #applied: VehicleCommand = this.#command;
  #packV: number;
  #steerRad: [number, number, number, number] = [0, 0, 0, 0];
  #velocity: Vec3 = [0, 0, 0];
  #angularVelocity: Vec3 = [0, 0, 0];
  #forwardSpeed = 0;
  #acceleration: Vec3 = [0, 0, 0];
  #cache: VehicleState | undefined;

  constructor(rapier: Rapier, world: RapierWorld, params: VehicleParams, start: VehicleStart) {
    this.params = params;
    const { wheelbaseM: L, trackWidthM: W, wheelRadiusM: Rw, cogM } = params;
    this.#cog = cogM;
    this.#packV = params.batteryV;

    // Body frame = centre-of-gravity frame. The chassis frame (origin on the ground
    // between the axles) is offset from it by -cog; `pose` undoes that.
    const yaw = (start.yawDeg * Math.PI) / 180;
    const rotation = quatY(yaw);
    const cogWorld = rotate(rotation, cogM);
    const { bodyM } = params;
    const m = params.massKg;
    const inertia = { ...params.inertiaKgM2 };
    this.body = world.createRigidBody(
      rapier.RigidBodyDesc.dynamic()
        .setTranslation(start.x + cogWorld[0], cogWorld[1], start.z + cogWorld[2])
        .setRotation({ x: rotation[0], y: rotation[1], z: rotation[2], w: rotation[3] })
        .setAdditionalMassProperties(m, { x: 0, y: 0, z: 0 }, inertia, { x: 0, y: 0, z: 0, w: 1 })
        .setCanSleep(false),
    );

    // The body: a box from just above the ground up to the overall height.
    const boxBottom = TUNING.bodyClearanceM;
    const boxHeight = Math.max(bodyM.height - boxBottom, 0.01);
    this.collider = world.createCollider(
      rapier.ColliderDesc.cuboid(bodyM.width / 2, boxHeight / 2, bodyM.length / 2)
        .setTranslation(-cogM[0], boxBottom + boxHeight / 2 - cogM[1], -cogM[2])
        .setDensity(0)
        .setFriction(TUNING.bodyFriction)
        .setRestitution(0)
        .setCollisionGroups(groups(GROUP.vehicle, 0xffff))
        .setActiveEvents(rapier.ActiveEvents.COLLISION_EVENTS),
      this.body,
    );

    // Wheels in WHEEL_ORDER: front-left, front-right, rear-left, rear-right.
    // Front is −Z, left is −X. Each wheel's hard point is set so that, with the
    // car at rest on flat ground, its suspension has sagged under its share of
    // the weight and the chassis frame sits on the ground.
    const wheelXZ: readonly (readonly [number, number])[] = [
      [-W / 2, -L / 2],
      [W / 2, -L / 2],
      [-W / 2, L / 2],
      [W / 2, L / 2],
    ];
    // Placed parts (stage 2) can put the centre of gravity outside the wheels;
    // a wheel then carries nothing rather than a negative load.
    const clampShare = (share: number): number =>
      params.physicsStage === 2 ? Math.max(0, Math.min(1, share)) : share;
    const frontShare = clampShare((L / 2 - cogM[2]) / L);
    const leftShare = clampShare((W / 2 + cogM[0]) / W);
    const loads: number[] = [];
    this.#controller = world.createVehicleController(this.body);
    wheelXZ.forEach(([x, z], i) => {
      const alongShare = z < 0 ? frontShare : 1 - frontShare;
      const acrossShare = x < 0 ? 1 - leftShare : leftShare;
      const share = alongShare * acrossShare;
      loads.push(share * m * GRAVITY);
      const sag = (GRAVITY * share) / TUNING.stiffness;
      const hardPointY = Rw + TUNING.restLengthM - sag;
      const hardPoint: Vec3 = [x - cogM[0], hardPointY - cogM[1], z - cogM[2]];
      this.#hardPoints.push(hardPoint);
      this.#controller.addWheel(
        { x: hardPoint[0], y: hardPoint[1], z: hardPoint[2] },
        { x: 0, y: -1, z: 0 },
        // +X axle: positive engine force drives toward −Z, which is forward.
        { x: 1, y: 0, z: 0 },
        TUNING.restLengthM,
        Rw,
      );
      this.#controller.setWheelMaxSuspensionTravel(i, TUNING.maxTravelM);
      this.#controller.setWheelSuspensionStiffness(i, TUNING.stiffness);
      this.#controller.setWheelSuspensionCompression(i, TUNING.compressionDamping);
      this.#controller.setWheelSuspensionRelaxation(i, TUNING.relaxationDamping);
      this.#controller.setWheelMaxSuspensionForce(i, TUNING.maxSuspensionForceN);
      this.#controller.setWheelFrictionSlip(i, TUNING.frictionSlip);
      // Stage 2 applies the tyre forces itself.
      this.#controller.setWheelSideFrictionStiffness(
        i,
        params.physicsStage === 2 ? 0 : TUNING.sideFrictionStiffness,
      );
    });
    this.#loadN = loads;
    this.#wheelRest = wheelXZ.map(([x, z]): Vec3 => [x, Rw, z]);
    this.#driven =
      params.driveWheels === 'front'
        ? [0, 1]
        : params.driveWheels === 'rear'
          ? [2, 3]
          : [0, 1, 2, 3];
    this.#velocity = [0, 0, 0];
  }

  applyCommand(command: VehicleCommand): void {
    this.#command = command;
  }

  /**
   * The battery's terminal voltage under the motor load of the last step, volts.
   * The nominal voltage before the first step, and always in stage 1.
   */
  get packVolts(): number {
    return this.#packV;
  }

  /** The chassis-frame origin's rotation and position. */
  #origin(): { position: Vec3; rotation: Quat } {
    const t = this.body.translation();
    const r = this.body.rotation();
    const rotation: Quat = [r.x, r.y, r.z, r.w];
    const offset = rotate(rotation, this.#cog);
    return { position: [t.x - offset[0], t.y - offset[1], t.z - offset[2]], rotation };
  }

  /** Front wheel angles for a virtual centre-wheel angle (Ackermann), positive left. */
  #ackermann(centreRad: number): [number, number] {
    const { wheelbaseM: L, trackWidthM: W, maxSteerRad } = this.params;
    const delta = Math.max(-maxSteerRad, Math.min(maxSteerRad, centreRad));
    if (Math.abs(delta) < 1e-9) return [0, 0];
    // Turn radius of the rear-axle centre; the inner wheel turns tighter.
    const radius = L / Math.tan(Math.abs(delta));
    const inner = Math.atan(L / Math.max(radius - W / 2, 1e-6));
    const outer = Math.atan(L / (radius + W / 2));
    // Left turn (delta > 0): the left wheel is the inner one.
    return delta > 0 ? [inner, outer] : [-outer, -inner];
  }

  /**
   * Called by the world just before each physics step: applies the current
   * command, so it is the command "used by the next `World.step`". Sets the
   * steering, works out the motor and rolling-resistance forces from the
   * speed at the end of the last step, and queries the suspension (the
   * wheels' rays, which only look for the ground and ramps). The world makes
   * sure Rapier's spatial index holds those first.
   */
  beforeStep(dtS: number): void {
    this.#applied = this.#clamped(this.#command);
    const [fl, fr] = this.#ackermann(this.#applied.steerAngleRad);
    this.#steerRad = [fl, fr, 0, 0];
    this.#controller.setWheelSteering(0, fl);
    this.#controller.setWheelSteering(1, fr);
    if (this.params.physicsStage === 2) this.#driveWithTyres(dtS);
    else this.#drive(dtS);
    this.#cache = undefined;
  }

  /** Called by the world right after each physics step: records the car's motion over it. */
  afterStep(dtS: number): void {
    const v = this.body.linvel();
    this.#acceleration = [
      (v.x - this.#velocity[0]) / dtS,
      (v.y - this.#velocity[1]) / dtS,
      (v.z - this.#velocity[2]) / dtS,
    ];
    this.#velocity = [v.x, v.y, v.z];
    const av = this.body.angvel();
    this.#angularVelocity = [av.x, av.y, av.z];
    const r = this.body.rotation();
    const f = rotate([r.x, r.y, r.z, r.w], [0, 0, -1]);
    this.#forwardSpeed = v.x * f[0] + v.y * f[1] + v.z * f[2];
    this.#cache = undefined;
  }

  #drive(dtS: number): void {
    const command = this.#applied;
    const c = this.#controller;
    const p = this.params;

    // DC motor: torque falls linearly from the stall torque (scaled by duty) as
    // back-EMF rises to the duty-scaled no-load speed. Zero duty is open
    // circuit: the car coasts against rolling resistance.
    let forcePerWheel = 0;
    const duty = command.motorDuty;
    if (p.motor && duty !== 0 && this.#driven.length > 0) {
      const motorSpeed = (this.#forwardSpeed / p.wheelRadiusM) * p.finalDriveRatio;
      const noLoad = p.motor.kvRadPerSV * p.batteryV;
      const torque = p.motor.stallTorqueNm * (duty - motorSpeed / noLoad);
      forcePerWheel = (torque * p.finalDriveRatio) / p.wheelRadiusM / this.#driven.length;
    }
    for (let i = 0; i < 4; i++) {
      c.setWheelEngineForce(i, this.#driven.includes(i) ? forcePerWheel : 0);
      // Rolling resistance is a brake impulse limit: it opposes rolling without reversing it.
      c.setWheelBrake(i, TUNING.rollingResistance * (this.#loadN[i] ?? 0) * dtS);
    }
    this.#querySuspension(dtS);
  }

  #querySuspension(dtS: number): void {
    this.#controller.updateVehicle(dtS, undefined, groups(0xffff, GROUP.ground));
    this.#queried = true;
  }

  /**
   * The force the motor asks of each driven wheel, and the brake's resistance
   * there, N. Also sets the pack voltage under that load. Motor speed follows
   * the car's speed: the wheels have no inertia of their own.
   */
  #powertrain(): { driveN: number; brakeN: number } {
    const p = this.params;
    const { motorDuty: duty, brake } = this.#applied;
    this.#packV = p.batteryV;
    if (!p.motor || this.#driven.length === 0) return { driveN: 0, brakeN: 0 };
    const motorSpeed = (this.#forwardSpeed / p.wheelRadiusM) * p.finalDriveRatio;
    const toWheelN = p.finalDriveRatio / p.wheelRadiusM / this.#driven.length;
    if (brake) {
      return {
        driveN: 0,
        brakeN: brakeTorqueNm(p.motor, Math.abs(duty), motorSpeed) * toWheelN,
      };
    }
    const pack = { openCircuitV: p.batteryV, resistanceOhm: p.batteryResistanceOhm };
    const load = motorLoad(p.motor, pack, duty, motorSpeed);
    this.#packV = load.packV;
    return { driveN: load.torqueNm * toWheelN, brakeN: 0 };
  }

  /**
   * Stage 2: queries the suspension (which pushes the car up), then gives each
   * wheel on the ground its tyre impulse at the contact point.
   */
  #driveWithTyres(dtS: number): void {
    const { driveN, brakeN } = this.#powertrain();
    this.#querySuspension(dtS);

    const c = this.#controller;
    const body = this.body;
    const r = body.rotation();
    const rotation: Quat = [r.x, r.y, r.z, r.w];
    const inverse: Quat = [-r.x, -r.y, -r.z, r.w];
    const com = body.worldCom();
    const { massKg, inertiaKgM2: inertia } = this.params;
    const touching = [0, 1, 2, 3].filter((i) => c.wheelIsInContact(i));

    // All four are worked out from the same velocities, then applied, so no
    // wheel goes first. Each takes its share of the velocity it may cancel.
    const impulses = touching.flatMap((i) => {
      const at = c.wheelContactPoint(i);
      const n = c.wheelContactNormal(i);
      if (!at || !n) return [];
      const normal: Vec3 = [n.x, n.y, n.z];
      const heading = rotate(rotation, rotate(quatY(this.#steerRad[i] ?? 0), [0, 0, -1]));
      // along the ground
      const into = dot(heading, normal);
      const flat: Vec3 = [
        heading[0] - normal[0] * into,
        heading[1] - normal[1] * into,
        heading[2] - normal[2] * into,
      ];
      const length = Math.hypot(...flat);
      if (length < 1e-6) return [];
      const forward: Vec3 = [flat[0] / length, flat[1] / length, flat[2] / length];
      const right = cross(forward, normal);
      const velocity = body.velocityAtPoint(at);
      const v: Vec3 = [velocity.x, velocity.y, velocity.z];
      const arm: Vec3 = [at.x - com.x, at.y - com.y, at.z - com.z];
      /** The mass an impulse along `direction` at the contact point has to move. */
      const massAlong = (direction: Vec3): number => {
        const [x, y, z] = rotate(inverse, cross(arm, direction));
        const response = 1 / massKg + x ** 2 / inertia.x + y ** 2 / inertia.y + z ** 2 / inertia.z;
        return 1 / response / touching.length;
      };
      const loadN = Math.max(0, c.wheelSuspensionForce(i) ?? 0);
      const driven = this.#driven.includes(i);
      const impulse = tyreImpulse({
        loadN,
        forwardMps: dot(v, forward),
        rightMps: dot(v, right),
        driveN: driven ? driveN : 0,
        resistN: TUNING.rollingResistance * loadN + (driven ? brakeN : 0),
        forwardMassKg: massAlong(forward),
        rightMassKg: massAlong(right),
        dtS,
      });
      const j = (axis: 0 | 1 | 2): number =>
        forward[axis] * impulse.forward + right[axis] * impulse.right;
      return [{ impulse: { x: j(0), y: j(1), z: j(2) }, at: { x: at.x, y: at.y, z: at.z } }];
    });
    for (const { impulse, at } of impulses) body.applyImpulseAtPoint(impulse, at, true);
  }

  #clamped(command: VehicleCommand): VehicleCommand {
    const max = this.params.maxSteerRad;
    return {
      steerAngleRad: Math.max(-max, Math.min(max, command.steerAngleRad)),
      motorDuty: Math.max(-1, Math.min(1, command.motorDuty)),
      // Stage 1 has no brake.
      ...(command.brake && this.params.physicsStage === 2 ? { brake: true } : {}),
    };
  }

  state(): VehicleState {
    this.#cache ??= this.#computeState();
    return this.#cache;
  }

  #computeState(): VehicleState {
    const origin = this.#origin();
    const { rotation } = origin;
    const c = this.#controller;
    const wheels = WHEEL_ORDER.map((_, i): WheelState => {
      if (!this.#queried) {
        // No step yet: the car stands at rest where it was placed, so pose the
        // wheels from the geometry rather than from the unset suspension.
        const [x, y, z] = this.#wheelRest[i] as Vec3;
        const at = rotate(rotation, [x, y, z]);
        return {
          position: [
            origin.position[0] + at[0],
            origin.position[1] + at[1],
            origin.position[2] + at[2],
          ],
          rotation,
          steerRad: 0,
          spinRad: 0,
          inContact: false,
        };
      }
      // The controller caches its hard point before physics, so it would lag the
      // chassis by a step. Place the wheel from the chassis transform as it is
      // now, keeping the controller's suspension length and spin.
      const [hx, hy, hz] = this.#hardPoints[i] as Vec3;
      const length = c.wheelSuspensionLength(i) ?? TUNING.restLengthM;
      const local = rotate(rotation, [hx, hy - length, hz]);
      const body = this.body.translation();
      const steerRad = this.#steerRad[i] ?? 0;
      const spinRad = c.wheelRotation(i) ?? 0;
      return {
        position: [body.x + local[0], body.y + local[1], body.z + local[2]],
        // chassis × steer about the chassis Y axis × spin about the axle (−X rolls forward)
        rotation: quatMul(quatMul(rotation, quatY(steerRad)), quatX(-spinRad)),
        steerRad,
        spinRad,
        inContact: c.wheelIsInContact(i),
      };
    });
    return {
      pose: { position: origin.position, rotation },
      velocity: this.#velocity,
      angularVelocity: this.#angularVelocity,
      forwardSpeedMps: this.#forwardSpeed,
      acceleration: this.#acceleration,
      command: this.#applied,
      wheels: wheels as unknown as VehicleState['wheels'],
    };
  }

  chassisToWorld(offsetM: Vec3, yawRad: number, pitchRad: number): Pose {
    const { position, rotation } = this.#origin();
    const o = rotate(rotation, offsetM);
    return {
      position: [position[0] + o[0], position[1] + o[1], position[2] + o[2]],
      rotation: quatMul(quatMul(rotation, quatY(yawRad)), quatX(pitchRad)),
    };
  }
}
