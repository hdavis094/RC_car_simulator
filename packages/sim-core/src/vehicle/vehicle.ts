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

/**
 * The car: a rigid body with a Rapier ray-cast vehicle controller for the
 * four wheels. Ackermann steering on the front wheels, a DC-motor model
 * (stall torque, back-EMF) driving the driven wheels through the final drive.
 */
export class RapierVehicle implements Vehicle {
  readonly body: RigidBody;
  readonly collider: Collider;
  readonly params: VehicleParams;

  readonly #controller: DynamicRayCastVehicleController;
  readonly #cog: Vec3;
  readonly #driven: readonly number[];
  readonly #loadN: readonly number[];
  #command: VehicleCommand = { steerAngleRad: 0, motorDuty: 0 };
  #applied: VehicleCommand = this.#command;
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

    // Body frame = centre-of-gravity frame. The chassis frame (origin on the ground
    // between the axles) is offset from it by -cog; `pose` undoes that.
    const yaw = (start.yawDeg * Math.PI) / 180;
    const rotation = quatY(yaw);
    const cogWorld = rotate(rotation, cogM);
    const { bodyM } = params;
    const m = params.massKg;
    const inertia = {
      x: (m * (bodyM.height ** 2 + bodyM.length ** 2)) / 12,
      y: (m * (bodyM.width ** 2 + bodyM.length ** 2)) / 12,
      z: (m * (bodyM.width ** 2 + bodyM.height ** 2)) / 12,
    };
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
    const frontShare = (L / 2 - cogM[2]) / L;
    const leftShare = (W / 2 + cogM[0]) / W;
    const loads: number[] = [];
    this.#controller = world.createVehicleController(this.body);
    wheelXZ.forEach(([x, z], i) => {
      const alongShare = z < 0 ? frontShare : 1 - frontShare;
      const acrossShare = x < 0 ? 1 - leftShare : leftShare;
      const share = alongShare * acrossShare;
      loads.push(share * m * GRAVITY);
      const sag = (GRAVITY * share) / TUNING.stiffness;
      const hardPointY = Rw + TUNING.restLengthM - sag;
      this.#controller.addWheel(
        { x: x - cogM[0], y: hardPointY - cogM[1], z: z - cogM[2] },
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
      this.#controller.setWheelSideFrictionStiffness(i, TUNING.sideFrictionStiffness);
    });
    this.#loadN = loads;
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
   * Called by the world right after each physics step: records the car's
   * motion, then applies steering, drive and rolling resistance for the
   * next step. Querying the suspension here, after the step, means the
   * rays see the scene as the step just left it, with every obstacle edit
   * made since the last tick already in Rapier's spatial index (it is only
   * refreshed inside a step). A command takes effect one step after it is
   * applied.
   */
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
    this.#drive(dtS);
    this.#cache = undefined;
  }

  #drive(dtS: number): void {
    const command = this.#clamped(this.#command);
    this.#applied = command;
    const c = this.#controller;
    const p = this.params;

    const [fl, fr] = this.#ackermann(command.steerAngleRad);
    this.#steerRad = [fl, fr, 0, 0];
    c.setWheelSteering(0, fl);
    c.setWheelSteering(1, fr);

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
    c.updateVehicle(dtS, undefined, groups(0xffff, GROUP.ground));
  }

  #clamped(command: VehicleCommand): VehicleCommand {
    const max = this.params.maxSteerRad;
    return {
      steerAngleRad: Math.max(-max, Math.min(max, command.steerAngleRad)),
      motorDuty: Math.max(-1, Math.min(1, command.motorDuty)),
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
      const hard = c.wheelHardPoint(i) ?? { x: 0, y: 0, z: 0 };
      const length = c.wheelSuspensionLength(i) ?? TUNING.restLengthM;
      const down = rotate(rotation, [0, -length, 0]);
      const steerRad = this.#steerRad[i] ?? 0;
      const spinRad = c.wheelRotation(i) ?? 0;
      return {
        position: [hard.x + down[0], hard.y + down[1], hard.z + down[2]],
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
