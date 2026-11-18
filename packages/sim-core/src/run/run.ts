import type { Device, NetFaults } from '@rcsim/sim-protocol';
import { ActuatorSourceEnded, type TickInput } from '../api/actuator-source.ts';
import type { ActuatorModel } from '../api/actuators.ts';
import type { PartContext } from '../api/parts.ts';
import type {
  Run,
  RunEnd,
  RunEvents,
  RunOptions,
  RunStatus,
  RunStepResult,
  Unsubscribe,
} from '../api/run.ts';
import type { SensorModel } from '../api/sensors.ts';
import type { StateSnapshot } from '../api/snapshot.ts';
import { deviceKindOf, partContexts } from '../api/stubs/fake-run.ts';
import type { RngStreams } from '../api/clock.ts';
import { TickClock, createRngStreams } from '../clock/index.ts';
import { LapCounter } from '../world/lap-counter.ts';
import { createPhysicsWorld, type PhysicsWorld } from '../world/world.ts';
import { defaultActuatorModel, defaultSensorModel } from './default-models.ts';

const ACTUATOR_TEMPLATES = new Set(['servo', 'esc-motor']);
const SENSOR_TEMPLATES = new Set(['distance-raycast', 'imu', 'voltage-divider']);

/** The numbers a scenario asserts on, accumulated as the run goes. */
export interface RunMetrics {
  readonly collisions: number;
  readonly laps: number;
  readonly maxSpeedMps: number;
  readonly distanceM: number;
  readonly simSeconds: number;
}

/** A Run that also reports its metrics (the scenario runner reads them). */
export interface MeasuredRun extends Run {
  metrics(): RunMetrics;
}

const templateOf = (part: PartContext): string =>
  'behavior' in part.definition ? part.definition.behavior.template : '';

const isWired = (part: PartContext): boolean => Object.keys(part.gpioPins).length > 0;

/** The sim-protocol device table: wired parts that have a device kind, in car.json order. */
function deviceTable(contexts: readonly PartContext[]): Device[] {
  return contexts
    .filter((p) => deviceKindOf(p) !== null && isWired(p))
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
}

/**
 * Assembles a run: clock, seeded streams, physics world, vehicle, actuator
 * and sensor models, and the source that drives them. Follows the tick order
 * documented on `Run`.
 */
export async function createRun(options: RunOptions): Promise<MeasuredRun> {
  const clock = new TickClock(options.tickUs ?? 1000);
  const rng = createRngStreams(options.seed);
  const world = await createPhysicsWorld(options.world, options.track);
  try {
    return await assemble(options, clock, rng, world);
  } catch (error) {
    world.dispose();
    throw error;
  }
}

async function assemble(
  options: RunOptions,
  clock: TickClock,
  rng: RngStreams,
  world: PhysicsWorld,
): Promise<MeasuredRun> {
  const vehicle = world.createVehicle({ car: options.car, catalog: options.catalog });
  const createActuator = options.createActuatorModel ?? defaultActuatorModel;
  const createSensor = options.createSensorModel ?? defaultSensorModel;

  const contexts = partContexts(options, rng);
  // Only wired parts get models, so every reading maps to a device.
  const actuators: ActuatorModel[] = contexts
    .filter((p) => ACTUATOR_TEMPLATES.has(templateOf(p)) && isWired(p))
    .map((p) => createActuator(p));
  const sensorParts = contexts.filter((p) => SENSOR_TEMPLATES.has(templateOf(p)) && isWired(p));
  const sensors: SensorModel[] = sensorParts.map((p) => createSensor(p));
  const pinOwners = sensorParts.map((part, i) => ({
    gpios: new Set(Object.values(part.gpioPins)),
    sensor: sensors[i] as SensorModel,
  }));

  const source = options.source;
  await source.start({
    car: options.car,
    catalog: options.catalog,
    seed: options.seed,
    tickUs: clock.tickUs,
    devices: deviceTable(contexts),
  });

  const listeners: { [E in keyof RunEvents]: Set<RunEvents[E]> } = {
    serial: new Set(),
    log: new Set(),
    net: new Set(),
    end: new Set(),
  };
  const laps = new LapCounter(options.track);
  let status: RunStatus = 'ready';
  let end: RunEnd | null = null;
  let pendingReadings: TickInput['readings'] = [];
  let serialRx = new Uint8Array(0);
  let netFaults: NetFaults | undefined;
  let collisions = 0;
  let lastCollision: string | null = null;
  let maxSpeedMps = 0;
  let distanceM = 0;
  let lastPosition = vehicle.state().pose.position;
  let stepping = false;
  /** The `step()` call in progress, so `stop()` can wait for its tick to settle. */
  let activeStep: Promise<unknown> | undefined;
  let stopping: Promise<void> | undefined;
  /** The last snapshot, kept when the physics world is freed. */
  let finalSnapshot: StateSnapshot | undefined;

  /** Calls every listener of an event; one that throws affects neither the run nor the others. */
  const emit = <E extends keyof RunEvents>(event: E, ...args: Parameters<RunEvents[E]>): void => {
    for (const listener of listeners[event] as Set<(...a: Parameters<RunEvents[E]>) => void>) {
      try {
        listener(...args);
      } catch {
        // A listener's failure must not change how the run went, or skip the others.
      }
    }
  };

  /** Ends the run once; later reasons are ignored (a stop beats the failure it causes). */
  const finish = (why: RunEnd): void => {
    if (status === 'ended') return;
    status = 'ended';
    end = why;
    emit('end', why);
  };

  const buildSnapshot = (): StateSnapshot => {
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
      laps: { count: laps.count, lapTimesUs: [...laps.lapTimesUs] },
      collisions: { count: collisions, last: lastCollision },
    };
  };

  const runTick = async (): Promise<boolean> => {
    const t0Us = clock.nowUs;
    const t1Us = t0Us + clock.tickUs;
    // 1. the source runs the tick. Inputs are taken first, so serial or faults
    // queued while the source is busy wait for the next tick.
    const input: TickInput = {
      tick: clock.tick,
      t0Us,
      t1Us,
      readings: pendingReadings,
      // Ascending tUs across all sensors; ties keep car.json order.
      gpioEdges: sensors
        .flatMap((s) => s.takeGpioEdges?.(t0Us, t1Us) ?? [])
        .map((edge, order) => ({ edge, order }))
        .sort((a, b) => a.edge.tUs - b.edge.tUs || a.order - b.order)
        .map(({ edge }) => edge),
      serialRx,
      netFaults,
    };
    serialRx = new Uint8Array(0);
    netFaults = undefined;
    const output = await source.step(input);
    // stop() may have run while the source was busy: do nothing more.
    if (status === 'ended') return false;
    if (output.serialTx.length > 0) emit('serial', output.serialTx, t0Us);
    for (const line of output.logs) emit('log', line, t0Us);
    for (const event of output.netEvents) emit('net', event, t0Us);
    // 2. PWM into actuators; GPIO writes to the sensors that own the pins
    for (const pwm of output.pwm) {
      for (const actuator of actuators) if (actuator.gpio === pwm.gpio) actuator.setPwm(pwm, t0Us);
    }
    for (const write of output.gpioWrites) {
      for (const owner of pinOwners) {
        if (owner.gpios.has(write.gpio)) owner.sensor.onGpioWrite?.(write);
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
    // 4. physics; collisions and laps counted
    const events = world.step(clock.tickUs / 1_000_000, t1Us);
    collisions += events.collisions.length;
    const last = events.collisions.at(-1);
    if (last) lastCollision = last.with.kind === 'obstacle' ? last.with.id : 'wall';
    const state = vehicle.state();
    const [x, , z] = state.pose.position;
    laps.update({ x, z }, t1Us);
    distanceM += Math.hypot(x - lastPosition[0], z - lastPosition[2]);
    lastPosition = state.pose.position;
    maxSpeedMps = Math.max(maxSpeedMps, Math.hypot(...state.velocity));
    // 5. sensors; readings are kept for the next STEP
    pendingReadings = sensors.flatMap((sensor) =>
      sensor
        .update({
          nowUs: t1Us,
          dtUs: clock.tickUs,
          world,
          vehicle: state,
          rng: rng.stream(`sensor:${sensor.instanceId}`), // = PartContext.stream()
        })
        .map((reading) => ({ ...reading, instanceId: sensor.instanceId })),
    );
    // 6. time
    clock.advance();
    return true;
  };

  /** One tick; a failure anywhere in it ends the run rather than rejecting `step`. */
  const tick = async (): Promise<boolean> => {
    try {
      return await runTick();
    } catch (error) {
      finish(
        error instanceof ActuatorSourceEnded
          ? error.end
          : { kind: 'error', message: error instanceof Error ? error.message : String(error) },
      );
      return false;
    }
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
    step(ticks = 1): Promise<RunStepResult> {
      if (stepping)
        return Promise.reject(new Error('Run.step called while a previous step is pending'));
      stepping = true;
      const pending = (async (): Promise<RunStepResult> => {
        let done = 0;
        try {
          while (done < ticks && status !== 'ended') {
            status = 'running';
            if (!(await tick())) break;
            done += 1;
          }
        } finally {
          stepping = false;
        }
        return { ticks: done, status, end };
      })();
      activeStep = pending;
      return pending;
    },
    snapshot(): StateSnapshot {
      return finalSnapshot ?? buildSnapshot();
    },
    metrics(): RunMetrics {
      return {
        collisions,
        laps: laps.count,
        maxSpeedMps,
        distanceM,
        simSeconds: clock.nowUs / 1_000_000,
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
    async restartFirmware(): Promise<void> {
      if (!source.restart) throw new Error('this actuator source cannot restart');
      await source.restart();
    },
    stop(): Promise<void> {
      // One shutdown: ends the run, releases the source, waits for a tick in
      // progress to settle, then frees the physics world (keeping the last
      // snapshot). The shared promise is installed before `end` is emitted, so
      // a listener that calls `stop()` gets this promise, not a second shutdown.
      if (stopping) return stopping;
      const { promise, resolve, reject } = Promise.withResolvers<void>();
      stopping = promise;
      void (async () => {
        finish({ kind: 'stopped' });
        try {
          await source.stop();
        } finally {
          await activeStep?.catch(() => undefined);
          finalSnapshot = buildSnapshot();
          world.dispose();
        }
      })().then(resolve, reject);
      return promise;
    },
  };
}
