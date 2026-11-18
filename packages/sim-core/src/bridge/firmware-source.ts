import { mkdir, rm } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import {
  LIMITS,
  PROTOCOL_VERSION,
  ProtocolError,
  type Message,
  type NetFaults,
  type Reading,
  type Step,
} from '@rcsim/sim-protocol';
import {
  ActuatorSourceEnded,
  type ActuatorSource,
  type ActuatorSourceSetup,
  type FirmwareSourceOptions,
  type SourceEnd,
  type TickInput,
  type TickOutput,
} from '../api/actuator-source.ts';
import { Channel, type ChannelEvent } from './channel.ts';
import { FirmwareProcess, type ExitInfo } from './process.ts';

/** Virtual time each hal call costs, and each `loop()` return (SPEC.md → CONFIG). */
export const HAL_CALL_COST_NS = 1000;
export const LOOP_COST_NS = 5000;
export const DEFAULT_STALL_TIMEOUT_MS = 2000;
export const DEFAULT_BIND_ADDRESS = '127.0.0.1';

/** How long a firmware process gets to exit after BYE before it is killed. */
const EXIT_GRACE_MS = 500;
/** How long to wait for the exit status of a process whose connection is gone. */
const EXIT_STATUS_MS = 1000;

let socketCounter = 0;

/** `<project>/.rcsim/build/firmware` runs in `<project>`; any other binary in its own directory. */
function defaultCwd(binary: string): string {
  const dir = path.dirname(path.resolve(binary));
  return path.basename(dir) === 'build' && path.basename(path.dirname(dir)) === '.rcsim'
    ? path.dirname(path.dirname(dir))
    : dir;
}

type Waited<T> =
  | { readonly kind: 'value'; readonly value: T }
  | { readonly kind: 'exit'; readonly info: ExitInfo }
  | { readonly kind: 'spawn-error'; readonly error: Error }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'stopped' };

const immediate = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.length === 0) return b;
  if (b.length === 0) return a;
  const joined = new Uint8Array(a.length + b.length);
  joined.set(a);
  joined.set(b, a.length);
  return joined;
}

/**
 * The firmware bridge: runs a firmware process built by hal's build-sim in
 * lockstep over sim-protocol, and presents it to the Run as an
 * `ActuatorSource` (docs/ARCHITECTURE.md → Lockstep time).
 *
 * The bridge is the protocol server. `start` listens on a Unix socket under
 * /tmp, spawns the binary with `RCSIM_SOCKET`, and performs HELLO/CONFIG.
 * Each `step` sends one STEP and waits for its STEP_DONE, with a wall-clock
 * stall timeout (the one place sim-core looks at wall time, ADR 0003).
 */
export class FirmwareSource implements ActuatorSource {
  readonly #binary: string;
  readonly #cwd: string;
  readonly #stallMs: number;
  readonly #bindAddress: string;

  #setup: ActuatorSourceSetup | undefined;
  #deviceIndex = new Map<string, number>();
  #server: net.Server | undefined;
  #socketPath = '';
  #pendingAccept: PromiseWithResolvers<net.Socket> | undefined;
  #proc: FirmwareProcess | undefined;
  #channel: Channel | undefined;
  #nextPromise: Promise<ChannelEvent> | undefined;
  /** `running` once connected, `ended` after a failure, `stopped` after stop(). */
  #state: 'new' | 'running' | 'ended' | 'stopped' = 'new';
  #lock: Promise<unknown> = Promise.resolve();
  readonly #stopSignal = Promise.withResolvers<void>();
  #stopping: Promise<void> | undefined;
  #rx: Uint8Array = new Uint8Array(0);
  #lastFaults: NetFaults | undefined;
  #resendFaults = false;

  constructor(options: FirmwareSourceOptions) {
    this.#binary = path.resolve(options.binary);
    this.#cwd = options.cwd ?? defaultCwd(this.#binary);
    this.#stallMs = options.stallTimeoutMs ?? DEFAULT_STALL_TIMEOUT_MS;
    this.#bindAddress = options.bindAddress ?? DEFAULT_BIND_ADDRESS;
  }

  /** The Unix socket the firmware connects to (empty before `start`). */
  get socketPath(): string {
    return this.#socketPath;
  }

  async start(setup: ActuatorSourceSetup): Promise<void> {
    if (this.#state !== 'new') throw new Error('FirmwareSource.start called twice');
    this.#state = 'running';
    this.#setup = setup;
    this.#deviceIndex = new Map(setup.devices.map((d, i) => [d.instanceId, i]));
    try {
      await this.#listen();
      await this.#launch();
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  step(input: TickInput): Promise<TickOutput> {
    return this.#exclusive(() => this.#step(input));
  }

  restart(): Promise<void> {
    return this.#exclusive(async () => {
      if (this.#state === 'stopped') throw new Error('the firmware source is stopped');
      if (this.#state === 'new') throw new Error('the firmware source is not started');
      await this.#terminateProcess();
      this.#state = 'running';
      // A rebooted board finds the same network conditions as before it went down.
      this.#resendFaults = this.#lastFaults !== undefined;
      await this.#launch();
    });
  }

  stop(): Promise<void> {
    this.#stopping ??= (async () => {
      this.#state = 'stopped';
      this.#stopSignal.resolve();
      await this.#terminateProcess();
      this.#pendingAccept?.reject(new Error('stopped'));
      this.#pendingAccept = undefined;
      const server = this.#server;
      this.#server = undefined;
      if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
      if (this.#socketPath) await rm(this.#socketPath, { force: true });
    })();
    return this.#stopping;
  }

  // ---- serialisation: a restart never overlaps a step ----

  #exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.#lock.then(fn, fn);
    this.#lock = result.catch(() => undefined);
    return result;
  }

  // ---- connection set-up ----

  async #listen(): Promise<void> {
    this.#socketPath = `/tmp/rcsim-${process.pid}-${++socketCounter}.sock`;
    if (Buffer.byteLength(this.#socketPath) >= 100) {
      throw new Error(`socket path "${this.#socketPath}" is too long (macOS limits it to 104)`);
    }
    await mkdir('/tmp', { recursive: true });
    await rm(this.#socketPath, { force: true });
    const server = net.createServer((socket) => {
      const pending = this.#pendingAccept;
      if (pending) {
        this.#pendingAccept = undefined;
        pending.resolve(socket);
      } else {
        socket.destroy(); // one connection per firmware process
      }
    });
    this.#server = server;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.#socketPath, () => {
        server.off('error', reject);
        resolve();
      });
    });
  }

  /** Spawns the firmware and completes the handshake (HELLO, then CONFIG). */
  async #launch(): Promise<void> {
    const setup = this.#setup as ActuatorSourceSetup;
    const accepted = Promise.withResolvers<net.Socket>();
    this.#pendingAccept = accepted;
    const proc = new FirmwareProcess(this.#binary, this.#cwd, {
      ...process.env,
      RCSIM_SOCKET: this.#socketPath,
    });
    this.#proc = proc;
    this.#channel = undefined;
    this.#nextPromise = undefined;

    const connected = await this.#wait(accepted.promise, proc);
    this.#pendingAccept = undefined;
    if (connected.kind !== 'value') {
      throw await this.#endOf(connected);
    }
    const channel = new Channel(connected.value);
    this.#channel = channel;

    const hello = await this.#receive(proc);
    if (hello.kind !== 'message' || hello.message.type !== 'HELLO') {
      throw await this.#unexpected(hello, 'HELLO');
    }
    if (hello.message.protocolVersion !== PROTOCOL_VERSION) {
      const message = `firmware speaks sim-protocol ${hello.message.protocolVersion}; this sim speaks ${PROTOCOL_VERSION}`;
      await channel.send({ type: 'BYE', reason: 'version-mismatch', message });
      await this.#terminateProcess();
      this.#state = 'ended';
      throw new ActuatorSourceEnded({ kind: 'error', message });
    }
    await channel.send({
      type: 'CONFIG',
      protocolVersion: PROTOCOL_VERSION,
      tickUs: setup.tickUs,
      seed: setup.seed,
      halCallCostNs: HAL_CALL_COST_NS,
      loopCostNs: LOOP_COST_NS,
      net: { bindAddress: this.#bindAddress },
      devices: setup.devices,
    });
  }

  // ---- one tick ----

  async #step(input: TickInput): Promise<TickOutput> {
    if (this.#state === 'stopped') throw new ActuatorSourceEnded({ kind: 'finished' });
    const proc = this.#proc;
    const channel = this.#channel;
    if (this.#state !== 'running' || !proc || !channel) {
      throw new ActuatorSourceEnded({ kind: 'error', message: 'the firmware has already ended' });
    }

    let step: Step;
    try {
      step = this.#buildStep(input);
      await channel.send(step); // a dead connection shows up as `closed` below
    } catch (error) {
      if (error instanceof ProtocolError) {
        throw await this.#fail(proc, {
          kind: 'error',
          message: `cannot send tick ${input.tick}: ${error.message}`,
        });
      }
      throw error;
    }

    const event = await this.#receive(proc);
    if (event.kind !== 'message' || event.message.type !== 'STEP_DONE') {
      throw await this.#unexpected(event, 'STEP_DONE');
    }
    const done = event.message;
    if (done.tick !== input.tick) {
      await channel.send({
        type: 'BYE',
        reason: 'malformed',
        message: `STEP_DONE ${done.tick} answers STEP ${input.tick}`,
      });
      throw await this.#fail(proc, {
        kind: 'error',
        message: `firmware answered tick ${input.tick} with STEP_DONE ${done.tick}`,
      });
    }
    return {
      pwm: done.pwm,
      gpioWrites: done.gpioWrites,
      serialTx: done.serialTx,
      netEvents: done.netEvents,
      logs: done.logs,
    };
  }

  #buildStep(input: TickInput): Step {
    const readings: Reading[] = [];
    for (const { instanceId, ...reading } of input.readings) {
      const device = this.#deviceIndex.get(instanceId);
      if (device !== undefined) readings.push({ ...reading, device } as Reading);
    }
    // SPEC: in device order, then by time. Stable, so the Run's own order breaks ties.
    readings.sort((a, b) => a.device - b.device || a.tUs - b.tUs);

    // At most 16 KiB of Serial RX per STEP; the rest follows in later ticks.
    const rx = concat(this.#rx, input.serialRx);
    this.#rx = rx.subarray(LIMITS.serialBytes);

    let netFaults = input.netFaults;
    if (netFaults) this.#lastFaults = netFaults;
    else if (this.#resendFaults) netFaults = this.#lastFaults;
    this.#resendFaults = false;

    return {
      type: 'STEP',
      tick: input.tick,
      t0Us: input.t0Us,
      t1Us: input.t1Us,
      readings,
      gpioEdges: input.gpioEdges,
      serialRx: rx.subarray(0, LIMITS.serialBytes),
      netFaults,
    };
  }

  // ---- waiting, and what the ways of not getting an answer mean ----

  #nextEvent(): Promise<ChannelEvent> {
    const channel = this.#channel as Channel;
    this.#nextPromise ??= channel.next().finally(() => {
      this.#nextPromise = undefined;
    });
    return this.#nextPromise;
  }

  /** Races `promise` against the process exiting, a stop, and the stall timeout. */
  async #wait<T>(promise: Promise<T>, proc: FirmwareProcess): Promise<Waited<T>> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<Waited<T>>((resolve) => {
      timer = setTimeout(() => resolve({ kind: 'timeout' }), this.#stallMs);
    });
    try {
      return await Promise.race([
        promise.then((value): Waited<T> => ({ kind: 'value', value })),
        proc.exit.then(
          (info): Waited<T> => ({ kind: 'exit', info }),
          (error: Error): Waited<T> => ({ kind: 'spawn-error', error }),
        ),
        this.#stopSignal.promise.then((): Waited<T> => ({ kind: 'stopped' })),
        timeout,
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** The next channel event, or a failure the caller turns into an end. */
  async #receive(
    proc: FirmwareProcess,
  ): Promise<ChannelEvent | Exclude<Waited<ChannelEvent>, { kind: 'value' }>> {
    const waited = await this.#wait(this.#nextEvent(), proc);
    return waited.kind === 'value' ? waited.value : waited;
  }

  /** Turns anything but the expected message into the error that ends the source. */
  async #unexpected(
    event: ChannelEvent | Exclude<Waited<ChannelEvent>, { kind: 'value' }>,
    expected: string,
  ): Promise<ActuatorSourceEnded> {
    if (event.kind === 'message') {
      const message: Message = event.message;
      if (message.type === 'BYE') return this.#endOf({ kind: 'closed' }, message);
      const detail = `expected ${expected}, got ${message.type}`;
      await this.#channel?.send({ type: 'BYE', reason: 'malformed', message: detail });
      return this.#fail(this.#proc as FirmwareProcess, {
        kind: 'error',
        message: `firmware protocol error: ${detail}`,
      });
    }
    return this.#endOf(event);
  }

  /**
   * The end that a lost connection, an exit, a stall or a stop amounts to.
   * Kills the process and settles its exit status first.
   */
  async #endOf(
    what: Exclude<ChannelEvent, { kind: 'message' }> | Exclude<Waited<unknown>, { kind: 'value' }>,
    bye?: Extract<Message, { type: 'BYE' }>,
  ): Promise<ActuatorSourceEnded> {
    const proc = this.#proc as FirmwareProcess;
    if (what.kind === 'stopped' || this.#state === 'stopped') {
      return new ActuatorSourceEnded({ kind: 'finished' });
    }
    if (what.kind === 'timeout') {
      await this.#channel?.send({ type: 'BYE', reason: 'stalled', message: 'no STEP_DONE' });
      this.#state = 'ended';
      proc.kill('SIGKILL');
      await proc.exit.catch(() => undefined);
      this.#channel?.destroy();
      return new ActuatorSourceEnded({ kind: 'stalled', afterMs: this.#stallMs });
    }
    if (what.kind === 'spawn-error') {
      this.#state = 'ended';
      return new ActuatorSourceEnded({
        kind: 'error',
        message: `cannot start firmware "${this.#binary}": ${what.error.message}`,
      });
    }
    // A lost connection, a malformed frame or an exit: crashed, with the exit status.
    const malformed = what.kind === 'malformed' ? what.reason : undefined;
    const info = what.kind === 'exit' ? what.info : await this.#settle(proc);
    // A BYE or a last event the firmware managed to send before dying.
    let farewell = bye;
    if (!farewell && this.#channel) {
      await immediate();
      await immediate();
      const late = await Promise.race([this.#nextEvent(), immediate().then(() => undefined)]);
      if (late?.kind === 'message' && late.message.type === 'BYE') farewell = late.message;
    }
    const tail = [...info.stderrTail];
    if (farewell && farewell.message !== '') {
      tail.push(`[firmware BYE ${farewell.reason}] ${farewell.message}`);
    }
    if (malformed) tail.push(`[sim] malformed frame from the firmware: ${malformed}`);
    this.#state = 'ended';
    this.#channel?.destroy();
    return new ActuatorSourceEnded({
      kind: 'crashed',
      exitCode: info.exitCode,
      signal: info.signal,
      stderrTail: tail,
    });
  }

  /** Ends the source with `end`, killing the process. */
  async #fail(proc: FirmwareProcess, end: SourceEnd): Promise<ActuatorSourceEnded> {
    this.#state = this.#state === 'stopped' ? 'stopped' : 'ended';
    proc.kill('SIGKILL');
    await proc.exit.catch(() => undefined);
    this.#channel?.destroy();
    return new ActuatorSourceEnded(end);
  }

  /** Waits for a process whose connection is gone to report its exit status. */
  async #settle(proc: FirmwareProcess): Promise<ExitInfo> {
    const timer = Promise.withResolvers<undefined>();
    const handle = setTimeout(() => timer.resolve(undefined), EXIT_STATUS_MS);
    try {
      const info = await Promise.race([proc.exit.catch(() => undefined), timer.promise]);
      if (info) return info;
      proc.kill('SIGKILL');
      return (
        (await proc.exit.catch(() => undefined)) ?? {
          exitCode: null,
          signal: 'SIGKILL',
          stderrTail: [],
        }
      );
    } finally {
      clearTimeout(handle);
    }
  }

  /** Says goodbye to the current process and waits for it to go; kills it if it lingers. */
  async #terminateProcess(): Promise<void> {
    const proc = this.#proc;
    const channel = this.#channel;
    this.#proc = undefined;
    this.#channel = undefined;
    this.#nextPromise = undefined;
    if (!proc) return;
    if (channel && !channel.closed) {
      try {
        await channel.send({ type: 'BYE', reason: 'shutdown', message: 'the sim is stopping' });
      } catch {
        // the peer is gone already
      }
      channel.end();
    }
    const handle = setTimeout(() => proc.kill('SIGKILL'), EXIT_GRACE_MS);
    try {
      await proc.exit.catch(() => undefined);
    } finally {
      clearTimeout(handle);
      channel?.destroy();
    }
  }
}

/** Creates the firmware bridge's `ActuatorSource` (sim-core/src/bridge). */
export function createFirmwareSource(options: FirmwareSourceOptions): FirmwareSource {
  return new FirmwareSource(options);
}
