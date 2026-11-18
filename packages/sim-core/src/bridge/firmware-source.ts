import { mkdir, rm } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import {
  LIMITS,
  PROTOCOL_VERSION,
  ProtocolError,
  encodeFrame,
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
import { FirmwareProcess, trackSocket, untrackSocket, type ExitInfo } from './process.ts';

/** Virtual time each hal call costs, and each `loop()` return (SPEC.md → CONFIG). */
export const HAL_CALL_COST_NS = 1000;
export const LOOP_COST_NS = 5000;
export const DEFAULT_STALL_TIMEOUT_MS = 2000;
/**
 * How long the firmware gets to start: spawn, connect, HELLO, CONFIG. Separate
 * from the per-step stall timeout: a process start on a slow machine (a busy CI
 * runner, a cold disk) is not a stalled step.
 */
export const DEFAULT_STARTUP_TIMEOUT_MS = 10_000;
export const DEFAULT_BIND_ADDRESS = '127.0.0.1';

/** `FirmwareSourceOptions` plus what the bridge itself adds. */
export interface BridgeOptions extends FirmwareSourceOptions {
  /** Wall-clock limit for starting the firmware (spawn to CONFIG), also on restart; default 10 000 ms. */
  readonly startupTimeoutMs?: number;
}

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
  | { readonly kind: 'timeout'; readonly afterMs: number }
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
  readonly #startupMs: number;
  /** True from spawn to the end of the handshake: waits then get the startup deadline. */
  #booting = false;
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
  /**
   * Wakes the wait in progress (at most one: steps are serialised) when the
   * process exits or the source is stopped. Long-lived promises are never
   * raced per tick: every `then` on one would stay attached for good.
   */
  #slot: ((waited: Waited<never>) => void) | undefined;
  /** How the current process ended, if it has. */
  #exited: Extract<Waited<never>, { kind: 'exit' | 'spawn-error' }> | undefined;
  /** What the peer may send now; checked as each message is decoded. */
  #expect:
    { readonly kind: 'hello' | 'none' } | { readonly kind: 'step-done'; readonly tick: number } = {
    kind: 'none',
  };
  #starting: Promise<void> | undefined;
  #stopping: Promise<void> | undefined;
  /** GPIOs the firmware is driving with PWM, by the STEP_DONEs so far. */
  readonly #activePwm = new Set<number>();
  /** After a reboot: pins whose signal is gone, reported with the next tick. */
  #lostPwm: number[] = [];
  #rx: Uint8Array = new Uint8Array(0);
  #lastFaults: NetFaults | undefined;
  #resendFaults = false;

  constructor(options: BridgeOptions) {
    this.#binary = path.resolve(options.binary);
    this.#cwd = options.cwd ?? defaultCwd(this.#binary);
    this.#stallMs = options.stallTimeoutMs ?? DEFAULT_STALL_TIMEOUT_MS;
    this.#startupMs = options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
    this.#bindAddress = options.bindAddress ?? DEFAULT_BIND_ADDRESS;
  }

  /** The Unix socket the firmware connects to (empty before `start`). */
  get socketPath(): string {
    return this.#socketPath;
  }

  /** The firmware's process id, while it runs. */
  get pid(): number | undefined {
    return this.#proc?.pid;
  }

  /** The current firmware process (diagnostics and tests). */
  get process(): FirmwareProcess | undefined {
    return this.#proc;
  }

  async start(setup: ActuatorSourceSetup): Promise<void> {
    if (this.#state !== 'new') throw new Error('FirmwareSource.start called twice');
    this.#state = 'running';
    this.#setup = setup;
    this.#deviceIndex = new Map(setup.devices.map((d, i) => [d.instanceId, i]));
    this.#starting = (async () => {
      await this.#listen();
      await this.#launch();
    })();
    try {
      await this.#starting;
    } catch (error) {
      await this.#cleanup();
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
      this.#checkNotStopped();
      this.#state = 'running';
      // A rebooted board finds the same network conditions as before it went down...
      this.#resendFaults = this.#lastFaults !== undefined;
      // ...but its pins are no longer driven: whatever PWM the old firmware held is gone.
      // (A reset still waiting to be reported stays: restarts may come back to back.)
      this.#lostPwm = [...new Set([...this.#lostPwm, ...this.#activePwm])];
      this.#activePwm.clear();
      await this.#launch();
    });
  }

  /**
   * Ends the source: kills the firmware, closes and removes the socket. Safe
   * at any time, also while `start` is still going (it is waited for, then
   * undone), and safe to call twice.
   */
  stop(): Promise<void> {
    this.#state = 'stopped';
    this.#slot?.({ kind: 'stopped' });
    this.#pendingAccept?.reject(new Error('stopped'));
    this.#pendingAccept = undefined;
    // `start` checks for the stop after each of its waits and bails out; what it
    // made before noticing is cleaned up below, after it has settled.
    return this.#cleanup();
  }

  #cleanup(): Promise<void> {
    this.#stopping ??= (async () => {
      this.#state = 'stopped';
      await this.#starting?.catch(() => undefined);
      await this.#terminateProcess();
      const server = this.#server;
      this.#server = undefined;
      if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
      if (this.#socketPath) {
        await rm(this.#socketPath, { force: true });
        untrackSocket(this.#socketPath);
      }
    })();
    return this.#stopping;
  }

  #checkNotStopped(): void {
    if (this.#state === 'stopped') throw new ActuatorSourceEnded({ kind: 'finished' });
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
    this.#checkNotStopped();
    trackSocket(this.#socketPath);
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
    this.#checkNotStopped();
  }

  /** Spawns the firmware and completes the handshake (HELLO, then CONFIG). */
  async #launch(): Promise<void> {
    this.#booting = true;
    try {
      await this.#spawnAndHandshake();
    } finally {
      this.#booting = false;
    }
  }

  async #spawnAndHandshake(): Promise<void> {
    const setup = this.#setup as ActuatorSourceSetup;
    // No await between this check and the spawn: a stop can't slip in between.
    this.#checkNotStopped();
    const accepted = Promise.withResolvers<net.Socket>();
    this.#pendingAccept = accepted;
    const proc = new FirmwareProcess(this.#binary, this.#cwd, {
      ...process.env,
      RCSIM_SOCKET: this.#socketPath,
    });
    this.#proc = proc;
    this.#channel = undefined;
    this.#nextPromise = undefined;
    this.#exited = undefined;
    this.#expect = { kind: 'hello' };
    // One reaction per process, for its whole life.
    proc.exit.then(
      (info) => this.#onExit(proc, { kind: 'exit', info }),
      (error: Error) => this.#onExit(proc, { kind: 'spawn-error', error }),
    );

    const connected = await this.#wait(accepted.promise);
    this.#pendingAccept = undefined;
    if (connected.kind !== 'value') {
      throw await this.#endOf(connected);
    }
    const channel = new Channel(connected.value, (message) => this.#accept(message));
    this.#channel = channel;

    const hello = await this.#receive();
    if (hello.kind !== 'message' || hello.message.type !== 'HELLO') {
      throw await this.#unexpected(hello);
    }
    if (hello.message.protocolVersion !== PROTOCOL_VERSION) {
      const message = `firmware speaks sim-protocol ${hello.message.protocolVersion}; this sim speaks ${PROTOCOL_VERSION}`;
      // Never wait on a write to a firmware that may not be reading.
      void channel.send({ type: 'BYE', reason: 'version-mismatch', message });
      await this.#terminateProcess();
      this.#state = 'ended';
      throw new ActuatorSourceEnded({ kind: 'error', message });
    }
    this.#checkNotStopped();
    const sent = await this.#wait(
      channel.send({
        type: 'CONFIG',
        protocolVersion: PROTOCOL_VERSION,
        tickUs: setup.tickUs,
        seed: setup.seed,
        halCallCostNs: HAL_CALL_COST_NS,
        loopCostNs: LOOP_COST_NS,
        net: { bindAddress: this.#bindAddress },
        devices: setup.devices,
      }),
    );
    if (sent.kind !== 'value') throw await this.#endOf(sent);
    this.#expect = { kind: 'none' };
  }

  /**
   * The protocol state machine, applied to each message as it arrives (see
   * `Channel`): HELLO only first, STEP_DONE only while a STEP with that tick
   * is outstanding and not yet answered, BYE any time.
   */
  #accept(message: Message): string | undefined {
    if (message.type === 'BYE') return undefined;
    const expect = this.#expect;
    if (message.type === 'HELLO' && expect.kind === 'hello') {
      this.#expect = { kind: 'none' };
      return undefined;
    }
    if (message.type === 'STEP_DONE' && expect.kind === 'step-done') {
      if (message.tick !== expect.tick) {
        return `STEP_DONE ${message.tick} does not answer STEP ${expect.tick}`;
      }
      this.#expect = { kind: 'none' };
      return undefined;
    }
    const wanted =
      expect.kind === 'hello'
        ? 'HELLO'
        : expect.kind === 'step-done'
          ? `STEP_DONE for tick ${expect.tick}`
          : 'nothing (no STEP is outstanding)';
    return `unexpected ${message.type}; the sim is waiting for ${wanted}`;
  }

  #onExit(
    proc: FirmwareProcess,
    exited: Extract<Waited<never>, { kind: 'exit' | 'spawn-error' }>,
  ): void {
    if (proc !== this.#proc) return; // a process the sim has already let go
    this.#exited = exited;
    this.#slot?.(exited);
  }

  // ---- one tick ----

  async #step(input: TickInput): Promise<TickOutput> {
    if (this.#state === 'stopped') throw new ActuatorSourceEnded({ kind: 'finished' });
    const proc = this.#proc;
    const channel = this.#channel;
    if (this.#state !== 'running' || !proc || !channel) {
      throw new ActuatorSourceEnded({ kind: 'error', message: 'the firmware has already ended' });
    }

    let frame: Uint8Array;
    try {
      frame = encodeFrame(this.#buildStep(input));
    } catch (error) {
      if (error instanceof ProtocolError) {
        throw await this.#fail(proc, {
          kind: 'error',
          message: `cannot send tick ${input.tick}: ${error.message}`,
        });
      }
      throw error;
    }
    this.#expect = { kind: 'step-done', tick: input.tick };

    // Sending the STEP and waiting for its STEP_DONE are one wait under one stall
    // timer: a firmware that isn't reading (its socket full) stalls the tick like
    // one that never answers. A dead connection shows up as `closed`.
    const answered = await this.#wait(
      (async () => {
        await channel.sendFrame(frame);
        return this.#nextEvent();
      })(),
    );
    const event = answered.kind === 'value' ? answered.value : answered;
    if (event.kind !== 'message' || event.message.type !== 'STEP_DONE') {
      throw await this.#unexpected(event);
    }
    // Frames are applied one at a time, in wire order, whatever the chunking: this
    // answer was valid, so its tick completes and its outputs stand. A bad frame
    // behind it is the next event the channel hands over, and ends the run there.
    const done = event.message; // `#accept` has checked that it answers this tick
    // A rebooted firmware starts with nothing driving its pins: say so first, so
    // anything it sets up in this very tick still wins.
    const lost = this.#lostPwm.map((gpio) => ({ gpio, periodUs: 0, pulseUs: 0 }));
    this.#lostPwm = [];
    for (const pwm of done.pwm) {
      if (pwm.periodUs > 0) this.#activePwm.add(pwm.gpio);
      else this.#activePwm.delete(pwm.gpio);
    }
    return {
      pwm: lost.length > 0 ? [...lost, ...done.pwm] : done.pwm,
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
    const channel = this.#channel;
    if (!channel) return Promise.resolve({ kind: 'closed' });
    this.#nextPromise ??= channel.next().finally(() => {
      this.#nextPromise = undefined;
    });
    return this.#nextPromise;
  }

  /**
   * Waits for `promise` (a per-call promise) or for whatever ends the wait
   * first: the process exiting, a stop, the stall timeout. The process and
   * stop wake the single `#slot`; nothing long-lived is raced.
   */
  #wait<T>(promise: Promise<T>): Promise<Waited<T>> {
    if (this.#state === 'stopped') return Promise.resolve({ kind: 'stopped' });
    return new Promise<Waited<T>>((resolve) => {
      let settled = false;
      const done = (waited: Waited<T>): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (this.#slot === done) this.#slot = undefined;
        resolve(waited);
      };
      const limit = this.#booting ? this.#startupMs : this.#stallMs;
      const timer = setTimeout(() => done({ kind: 'timeout', afterMs: limit }), limit);
      this.#slot = done as (waited: Waited<never>) => void;
      promise.then(
        (value) => done({ kind: 'value', value }),
        () => done({ kind: 'stopped' }),
      );
      if (this.#exited) done(this.#exited);
    });
  }

  /** The next channel event, or a failure the caller turns into an end. */
  async #receive(): Promise<ChannelEvent | Exclude<Waited<ChannelEvent>, { kind: 'value' }>> {
    const waited = await this.#wait(this.#nextEvent());
    return waited.kind === 'value' ? waited.value : waited;
  }

  /** Turns anything but the expected message into the error that ends the source. */
  async #unexpected(
    event: ChannelEvent | Exclude<Waited<ChannelEvent>, { kind: 'value' }>,
  ): Promise<ActuatorSourceEnded> {
    if (event.kind === 'message') {
      // `#accept` lets only the expected message and BYE through.
      if (event.message.type === 'BYE') return this.#endOf({ kind: 'closed' }, event.message);
      return this.#fail(this.#proc as FirmwareProcess, {
        kind: 'error',
        message: `firmware protocol error: unexpected ${event.message.type}`,
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
      void this.#channel?.send({ type: 'BYE', reason: 'stalled', message: 'no STEP_DONE' });
      this.#state = 'ended';
      proc.kill('SIGKILL');
      await proc.exit.catch(() => undefined);
      this.#channel?.destroy();
      return new ActuatorSourceEnded({ kind: 'stalled', afterMs: what.afterMs });
    }
    if (what.kind === 'spawn-error') {
      this.#state = 'ended';
      return new ActuatorSourceEnded({
        kind: 'error',
        message: `cannot start firmware "${this.#binary}": ${what.error.message}`,
      });
    }
    if (what.kind === 'malformed') {
      // The channel has told the firmware (BYE malformed); the run ends as an error, per SPEC.md.
      return this.#fail(proc, {
        kind: 'error',
        message: `firmware protocol error: ${what.reason}`,
      });
    }
    // A lost connection or an exit: crashed, with the exit status.
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
    // The deadline starts first, and nothing below waits on the socket: a firmware
    // that isn't reading leaves a write pending for good.
    const handle = setTimeout(() => proc.kill('SIGKILL'), EXIT_GRACE_MS);
    if (channel && !channel.closed) {
      void channel.send({ type: 'BYE', reason: 'shutdown', message: 'the sim is stopping' });
      channel.end();
    }
    try {
      await proc.exit.catch(() => undefined);
    } finally {
      clearTimeout(handle);
      channel?.destroy();
    }
  }
}

/** Creates the firmware bridge's `ActuatorSource` (sim-core/src/bridge). */
export function createFirmwareSource(options: BridgeOptions): FirmwareSource {
  return new FirmwareSource(options);
}
