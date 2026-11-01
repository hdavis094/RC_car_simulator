import { gpioAssignments, type ChassisDefinition } from '@rcsim/schema';
import type { Device, NetFaults } from '@rcsim/sim-protocol';
import { ActuatorSourceEnded, type ActuatorSource, type TickInput } from '../actuator-source.ts';
import type { ActuatorModel, CreateActuatorModel } from '../actuators.ts';
import type { PartContext } from '../parts.ts';
import type {
  Run,
  RunEnd,
  RunEvents,
  RunOptions,
  RunStatus,
  RunStepResult,
  Unsubscribe,
} from '../run.ts';
import type { CreateSensorModel, SensorModel } from '../sensors.ts';
import type { StateSnapshot } from '../snapshot.ts';
import type { Vehicle } from '../vehicle.ts';
import type { World } from '../world.ts';
import { FakeClock } from './fake-clock.ts';
import { createFakeActuatorModel, createFakeSensorModel } from './fake-models.ts';
import { FakeWorld } from './fake-world.ts';
import { createRngStreams } from './rng.ts';

const ACTUATOR_TEMPLATES = new Set(['servo', 'esc-motor']);
const SENSOR_TEMPLATES = new Set(['distance-raycast', 'imu']);

/**
 * The sim-protocol device kind of a part, per SPEC.md's device-kind table.
 * The firmware bridge (P1-H) owns the real mapping; this follows the table.
 */
export function deviceKindOf(part: PartContext): string | null {
  const definition = part.definition;
  const template = 'behavior' in definition ? definition.behavior.template : undefined;
  if (definition.id.includes('vl53l0x')) return 'vl53l0x';
  if (definition.id.includes('mpu6050')) return 'mpu6050';
  if (definition.id.includes('hc-sr04')) return 'hc-sr04';
  if (template === 'servo') return 'servo';
  if (template === 'esc-motor') return 'esc';
  if (template === 'voltage-divider') return 'analog';
  return null;
}

/** Every part's PartContext, in car.json order. */
export function partContexts(options: Pick<RunOptions, 'car' | 'catalog'>): PartContext[] {
  const chassis = options.catalog.get(options.car.chassis.partId);
  if (chassis?.category !== 'chassis')
    throw new Error(`no chassis "${options.car.chassis.partId}"`);
  const pins = gpioAssignments(options.car, options.catalog);
  return options.car.parts.flatMap((instance) => {
    const definition = options.catalog.get(instance.partId);
    if (!definition) return [];
    return [
      {
        car: options.car,
        catalog: options.catalog,
        instance,
        definition,
        chassis: chassis as ChassisDefinition,
        gpioPins: pins[instance.instanceId] ?? {},
      },
    ];
  });
}

/**
 * A Run assembled from any World and models, following the tick order in
 * run.ts exactly: the reference loop for P1-A and P1-H. With no overrides it
 * uses FakeWorld and the fake models, so it needs no physics engine.
 */
export async function createFakeRun(
  options: RunOptions & { readonly worldImpl?: World },
): Promise<Run> {
  const clock = new FakeClock(options.tickUs ?? 1000);
  const rng = createRngStreams(options.seed);
  const world = options.worldImpl ?? new FakeWorld(options.world, options.track);
  const vehicle: Vehicle = world.createVehicle({ car: options.car, catalog: options.catalog });
  const createActuator: CreateActuatorModel =
    options.createActuatorModel ?? createFakeActuatorModel;
  const createSensor: CreateSensorModel =
    options.createSensorModel ?? ((part) => createFakeSensorModel(part));

  const contexts = partContexts(options);
  const template = (p: PartContext): string =>
    'behavior' in p.definition ? p.definition.behavior.template : '';
  const actuators: ActuatorModel[] = contexts
    .filter((p) => ACTUATOR_TEMPLATES.has(template(p)))
    .map(createActuator);
  const sensorParts = contexts.filter(
    (p) =>
      SENSOR_TEMPLATES.has(template(p)) ||
      (template(p) === 'voltage-divider' && Object.keys(p.gpioPins).length > 0),
  );
  const sensors: SensorModel[] = sensorParts.map(createSensor);
  const devices: Device[] = contexts
    .filter((p) => deviceKindOf(p) !== null && Object.keys(p.gpioPins).length > 0)
    .map((p) => ({
      instanceId: p.instance.instanceId,
      kind: deviceKindOf(p) ?? '',
      pins: Object.entries(p.gpioPins).map(([name, gpio]) => ({ name, gpio })),
      defaultI2cAddress:
        'i2c' in p.definition && p.definition.i2c ? p.definition.i2c.defaultAddress : 0,
      targetI2cAddress:
        'i2c' in p.definition && p.definition.i2c
          ? (p.instance.i2cAddress ?? p.definition.i2c.defaultAddress)
          : 0,
    }));

  const source: ActuatorSource = options.source;
  await source.start({
    car: options.car,
    catalog: options.catalog,
    seed: options.seed,
    tickUs: clock.tickUs,
    devices,
  });

  const listeners: { [E in keyof RunEvents]: Set<RunEvents[E]> } = {
    serial: new Set(),
    log: new Set(),
    net: new Set(),
    end: new Set(),
  };
  let status: RunStatus = 'ready';
  let end: RunEnd | null = null;
  let pendingReadings: TickInput['readings'] = [];
  let serialRx = new Uint8Array(0);
  let netFaults: NetFaults | undefined;
  const laps = 0; // the fake world has no track to lap
  let collisions = 0;
  let lastCollision: string | null = null;

  const finish = (why: RunEnd): void => {
    status = 'ended';
    end = why;
    for (const listener of listeners.end) listener(why);
  };

  const tick = async (): Promise<boolean> => {
    const t0Us = clock.nowUs;
    const t1Us = t0Us + clock.tickUs;
    // 1. the source runs the tick
    let output;
    try {
      output = await source.step({
        tick: clock.tick,
        t0Us,
        t1Us,
        readings: pendingReadings,
        gpioEdges: sensors.flatMap((s) => s.takeGpioEdges?.(t0Us, t1Us) ?? []),
        serialRx,
        netFaults,
      });
    } catch (error) {
      if (error instanceof ActuatorSourceEnded) {
        finish(error.end);
        return false;
      }
      throw error;
    }
    serialRx = new Uint8Array(0);
    netFaults = undefined;
    if (output.serialTx.length > 0) for (const l of listeners.serial) l(output.serialTx, t0Us);
    for (const line of output.logs) for (const l of listeners.log) l(line, t0Us);
    for (const event of output.netEvents) for (const l of listeners.net) l(event, t0Us);
    // 2. PWM into actuators; GPIO writes to the sensors that own the pins
    for (const pwm of output.pwm) {
      for (const actuator of actuators) if (actuator.gpio === pwm.gpio) actuator.setPwm(pwm, t0Us);
    }
    for (const write of output.gpioWrites) {
      for (const part of sensorParts) {
        if (Object.values(part.gpioPins).includes(write.gpio)) {
          sensors.find((s) => s.instanceId === part.instance.instanceId)?.onGpioWrite?.(write);
        }
      }
    }
    // 3. actuators → vehicle
    let steerAngleRad = 0;
    let motorDuty = 0;
    for (const actuator of actuators) {
      const out = actuator.update(t1Us);
      if (out.kind === 'steering') steerAngleRad = out.steerAngleRad;
      else motorDuty = out.motorDuty;
    }
    vehicle.applyCommand({ steerAngleRad, motorDuty });
    // 4. physics
    const events = world.step(clock.tickUs / 1_000_000, t1Us);
    collisions += events.collisions.length;
    const last = events.collisions.at(-1);
    if (last) lastCollision = last.with.kind === 'obstacle' ? last.with.id : 'wall';
    // 5. sensors, readings kept for the next STEP
    const state = vehicle.state();
    pendingReadings = sensors.flatMap((sensor) =>
      sensor
        .update({
          nowUs: t1Us,
          dtUs: clock.tickUs,
          world,
          vehicle: state,
          rng: rng.stream(`sensor:${sensor.instanceId}`),
        })
        .map((reading) => ({ ...reading, instanceId: sensor.instanceId })),
    );
    // 6. time
    clock.advance();
    return true;
  };

  return {
    clock,
    world,
    get status() {
      return status;
    },
    get end() {
      return end;
    },
    async step(ticks = 1): Promise<RunStepResult> {
      let done = 0;
      while (done < ticks && status !== 'ended') {
        status = 'running';
        if (!(await tick())) break;
        done += 1;
      }
      return { ticks: done, status, end };
    },
    snapshot(): StateSnapshot {
      const state = vehicle.state();
      return {
        tick: clock.tick,
        timeUs: clock.nowUs,
        status,
        car: {
          pose: state.pose,
          velocity: state.velocity,
          forwardSpeedMps: state.forwardSpeedMps,
          command: state.command,
          wheels: state.wheels,
        },
        sensors: sensors.map((s) => ({ instanceId: s.instanceId, beams: s.beams() })),
        obstacles: world.obstacles(),
        laps: { count: laps, lapTimesUs: [] },
        collisions: { count: collisions, last: lastCollision },
      };
    },
    sendSerial(bytes: Uint8Array): void {
      const joined = new Uint8Array(serialRx.length + bytes.length);
      joined.set(serialRx);
      joined.set(bytes, serialRx.length);
      serialRx = joined;
    },
    setNetFaults(faults: NetFaults): void {
      netFaults = faults;
    },
    on<E extends keyof RunEvents>(event: E, listener: RunEvents[E]): Unsubscribe {
      const set = listeners[event] as Set<RunEvents[E]>;
      set.add(listener);
      return () => set.delete(listener);
    },
    async stop(): Promise<void> {
      await source.stop();
      if (status !== 'ended') finish({ kind: 'stopped' });
    },
  };
}
