import net from 'node:net';
import { ClientMessage, DEFAULT_PORT, MAX_LINE_BYTES } from '@rcsim/control-protocol/messages';
import {
  ActuatorSourceEnded,
  type ActuatorSource,
  type ActuatorSourceSetup,
  type TickInput,
  type TickOutput,
} from '../api/actuator-source.ts';
import { DEFAULT_STALL_TIMEOUT_MS } from './firmware-source.ts';

/** A control-timeline file that is malformed (the CLI reports it as bad input). */
export class ControlScriptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ControlScriptError';
  }
}

/** One line to send to a firmware port at a sim time. */
export interface ControlEntry {
  readonly tUs: number;
  /** The firmware's own port (the one its `WiFiServer` was given), not the host port hal mapped it to. */
  readonly port: number;
  /** The line without its newline. */
  readonly line: string;
}

/** Most lines one timeline may expand to, repeats included. */
const MAX_ENTRIES = 200_000;

/**
 * Parses a `--control` timeline: a JSON array of
 *
 *   { "tUs": 1000000, "message": { "t": "drive", "seq": 1, "throttle": 0.3, "steer": 0 } }
 *   { "tUs": 2000000, "port": 3333, "line": "not json, sent as is" }
 *
 * `message` is a control-protocol client message, checked against its schema;
 * `line` is sent verbatim (to test how the firmware copes with junk). `port`
 * defaults to the control port, 3333. `everyMs` with `untilUs` repeats the
 * entry, the way a held stick is resent to beat the 500 ms failsafe; a repeated
 * `drive` has its `seq` raised by one each time (wrapping at 2³²). Entries are sent in time order.
 */
export function parseControlScript(value: unknown): ControlEntry[] {
  if (!Array.isArray(value))
    throw new ControlScriptError('a control timeline must be a JSON array');
  const entries: ControlEntry[] = [];
  value.forEach((raw: unknown, i) => {
    const where = `control entry ${i}`;
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new ControlScriptError(`${where} must be an object`);
    }
    const e = raw as Record<string, unknown>;
    const nonNegative = (key: string): number => {
      const v = e[key];
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
        throw new ControlScriptError(`${where}: "${key}" must be a number >= 0`);
      }
      return v;
    };
    const tUs = Math.round(nonNegative('tUs'));
    const port = e.port === undefined ? DEFAULT_PORT : e.port;
    if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
      throw new ControlScriptError(`${where}: "port" must be an integer 1..65535`);
    }
    if ((e.message === undefined) === (e.line === undefined)) {
      throw new ControlScriptError(`${where}: give exactly one of "message" and "line"`);
    }
    let line: string;
    let message: Record<string, unknown> | undefined;
    if (e.line !== undefined) {
      if (typeof e.line !== 'string' || e.line.includes('\n')) {
        throw new ControlScriptError(`${where}: "line" must be a string without a newline`);
      }
      line = e.line;
    } else {
      const parsed = ClientMessage.safeParse(e.message);
      if (!parsed.success) {
        throw new ControlScriptError(
          `${where}: "message" is not a control-protocol client message: ${parsed.error.message}`,
        );
      }
      message = e.message as Record<string, unknown>;
      line = JSON.stringify(message);
    }
    const lineFor = (n: number): string =>
      message?.t === 'drive' && n > 0
        ? // seq is a u32 that wraps, as a client's would
          JSON.stringify({ ...message, seq: ((message.seq as number) + n) % 2 ** 32 })
        : line;

    const emit = (at: number, n: number): void => {
      const text = lineFor(n);
      if (Buffer.byteLength(text) + 1 > MAX_LINE_BYTES) {
        throw new ControlScriptError(`${where}: the line is longer than ${MAX_LINE_BYTES} bytes`);
      }
      if (entries.length >= MAX_ENTRIES) {
        throw new ControlScriptError(
          `the control timeline expands to more than ${MAX_ENTRIES} lines`,
        );
      }
      entries.push({ tUs: at, port, line: text });
    };
    if (e.everyMs === undefined && e.untilUs === undefined) {
      emit(tUs, 0);
      return;
    }
    const everyMs = nonNegative('everyMs');
    if (everyMs === 0 || e.untilUs === undefined) {
      throw new ControlScriptError(`${where}: "everyMs" (> 0) and "untilUs" go together`);
    }
    const untilUs = nonNegative('untilUs');
    const everyUs = Math.round(everyMs * 1000);
    for (let n = 0, at = tUs; at <= untilUs; n += 1, at = tUs + n * everyUs) emit(at, n);
  });
  // Array.prototype.sort is stable: equal times keep file order.
  return entries.sort((a, b) => a.tUs - b.tUs);
}

/** An entry the run ended without delivering. */
export interface UndeliveredEntry extends ControlEntry {
  readonly reason: 'port-never-listened' | 'run-ended-first';
}

type Target = { readonly hostPort: number; readonly bindAddress: string };

interface Client {
  readonly socket: net.Socket;
  /** Settles when connected; rejects with the connect error. */
  readonly connected: Promise<void>;
  isConnected: boolean;
}

/**
 * The most control-line bytes one tick may deliver. The firmware reads its
 * sockets only while it runs a tick, so what is written before the tick has to
 * fit in the kernel's buffers (send queue plus the peer's receive queue,
 * 128 KiB or more on Linux and macOS loopback by default) without anyone
 * reading it. 32 KiB leaves room for the previous ticks' unread input.
 */
export const MAX_CONTROL_BYTES_PER_TICK = 32 * 1024;

/**
 * An `ActuatorSource` that plays a control timeline into the firmware it
 * wraps. Every other call passes through.
 *
 * **When.** An entry is written at the first tick boundary at or after its
 * `tUs`, never before: delivery is quantised to tick starts, so an entry is up
 * to one tick late (100 900 µs goes out at 101 000 µs with 1 ms ticks). It
 * goes to the firmware's TCP server, found through its LISTEN net event, so
 * the host port hal chose doesn't matter. An entry whose port isn't listening
 * yet waits, and so does everything after it.
 *
 * **Determinism.** The same firmware, world, seed and timeline must give a
 * bit-identical run, faults included, so every byte due for a tick has to be
 * in the firmware's receive buffer before that tick's STEP is sent: hal's
 * loss, latency and receive times depend on what is readable when it polls.
 * The step therefore writes the due lines, waits for the writes to complete
 * (the bytes are the kernel's), and only then sends STEP. What this relies on:
 * on loopback TCP the kernel queues a segment on the peer's socket as part
 * of the sender's `write` (Linux: the loopback device delivers through the
 * sending CPU's softirq, run as the sender leaves its syscall; macOS: the
 * loopback interface processes input in the sender's context). POSIX doesn't
 * promise this, and delivery deferred to a kernel thread (Linux's ksoftirqd
 * under extreme load) could still land late; macOS is not verified here. The
 * guarantee that needs no kernel cooperation is a STEP field carrying scripted
 * TCP payloads to hal (a sim-protocol change, proposed in the P1-H handoff).
 *
 * **Bounded.** The wait must end even though the firmware drains its socket
 * only while stepping, so one tick delivers at most
 * `MAX_CONTROL_BYTES_PER_TICK` bytes: more is an `error` end ("control input
 * for tick N exceeds ..."), not a hang or a stall. A write that still doesn't
 * complete within the stall timeout (the firmware's buffers are full because it
 * isn't reading) is an `error` too. An entry counts as delivered only once its
 * write has completed; the rest is reported by `undelivered()`.
 *
 * **No retries.** A failed write proves nothing about how much of it arrived, so
 * it is never retried (a retry could run commands twice): it ends the run with
 * an `error` naming the port and the tick, and the source takes no more steps.
 *
 * The car's replies (hello, telemetry) are read and kept in `received`.
 */
export class ControlledSource implements ActuatorSource {
  /** The last lines the firmware sent back over its control connections. */
  readonly received: string[] = [];
  readonly #inner: ActuatorSource;
  readonly #entries: readonly ControlEntry[];
  readonly #stallMs: number;
  readonly #delivered: boolean[];
  /** Everything before this index is delivered. */
  #cursor = 0;
  #stopped = false;
  /** Set by an ambiguous write failure: the source takes no further step. */
  #failure: ActuatorSourceEnded | undefined;
  #count = 0;
  readonly #listening = new Map<number, { hostPort: number; bindAddress: string }>();
  readonly #everListened = new Set<number>();
  readonly #clients = new Map<number, Client>();

  constructor(
    inner: ActuatorSource,
    entries: readonly ControlEntry[],
    options: { readonly stallTimeoutMs?: number } = {},
  ) {
    this.#inner = inner;
    this.#entries = entries;
    this.#delivered = new Array<boolean>(entries.length).fill(false);
    this.#stallMs = options.stallTimeoutMs ?? DEFAULT_STALL_TIMEOUT_MS;
  }

  /** Entries not yet delivered. */
  get pending(): number {
    return this.#entries.length - this.#count;
  }

  /** The entries the run has not delivered (so far), with why. */
  undelivered(): readonly UndeliveredEntry[] {
    return this.#entries.flatMap((entry, i) =>
      this.#delivered[i]
        ? []
        : [
            {
              ...entry,
              reason: this.#everListened.has(entry.port)
                ? ('run-ended-first' as const)
                : ('port-never-listened' as const),
            },
          ],
    );
  }

  /** A sentence naming the undelivered entries and their ports, or undefined when all went out. */
  describeUndelivered(): string | undefined {
    const left = this.undelivered();
    if (left.length === 0) return undefined;
    const why = (e: UndeliveredEntry): string =>
      e.reason === 'port-never-listened'
        ? 'the firmware never listened on it'
        : 'the run ended first';
    const shown = left
      .slice(0, 5)
      .map((e) => `tUs ${e.tUs} to port ${e.port} (${why(e)})`)
      .join('; ');
    const more = left.length > 5 ? `; and ${left.length - 5} more` : '';
    return `control: ${left.length} of ${this.#entries.length} timeline entries were never delivered: ${shown}${more}`;
  }

  start(setup: ActuatorSourceSetup): Promise<void> {
    return this.#inner.start(setup);
  }

  async step(input: TickInput): Promise<TickOutput> {
    if (this.#failure) throw this.#failure;
    await this.#deliverDue(input);
    const output = await this.#inner.step(input);
    for (const event of output.netEvents) {
      if (event.type === 'listen' && event.proto === 'tcp') {
        this.#listening.set(event.firmwarePort, {
          hostPort: event.hostPort,
          bindAddress: event.bindAddress,
        });
        this.#everListened.add(event.firmwarePort);
      } else if (event.type === 'unlisten' && event.proto === 'tcp') {
        this.#listening.delete(event.firmwarePort);
        this.#drop(event.firmwarePort);
      }
    }
    return output;
  }

  async restart(): Promise<void> {
    if (!this.#inner.restart) throw new Error('this actuator source cannot restart');
    // The rebooted firmware listens again, on new host ports.
    this.#listening.clear();
    for (const port of [...this.#clients.keys()]) this.#drop(port);
    await this.#inner.restart();
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    for (const port of [...this.#clients.keys()]) this.#drop(port);
    await this.#inner.stop();
  }

  /** Writes the entries due at this tick and waits until they are the kernel's. */
  async #deliverDue(input: TickInput): Promise<void> {
    // Collect first, per port in time order, so an excess fails before anything is written.
    const batches = new Map<number, { indices: number[]; text: string[] }>();
    let bytes = 0;
    let count = 0;
    for (let i = this.#cursor; i < this.#entries.length; i += 1) {
      if (this.#delivered[i]) continue;
      const entry = this.#entries[i] as ControlEntry;
      if (entry.tUs > input.t0Us) break; // not before its time
      if (!this.#listening.has(entry.port)) break;
      bytes += Buffer.byteLength(entry.line) + 1;
      count += 1;
      if (bytes > MAX_CONTROL_BYTES_PER_TICK) {
        throw new ActuatorSourceEnded({
          kind: 'error',
          message: `control input for tick ${input.tick} exceeds ${MAX_CONTROL_BYTES_PER_TICK} bytes (${count}+ entries due; the firmware reads its sockets only while it steps, so more than that could not be delivered before the tick)`,
        });
      }
      const batch = batches.get(entry.port) ?? { indices: [], text: [] };
      batch.indices.push(i);
      batch.text.push(`${entry.line}\n`);
      batches.set(entry.port, batch);
    }
    if (batches.size === 0) return;

    const writes: Promise<void>[] = [];
    let failedPort: number | undefined;
    for (const [port, batch] of batches) {
      const client = await this.#client(port, this.#listening.get(port) as Target);
      writes.push(
        new Promise<void>((resolve) => {
          client.socket.write(batch.text.join(''), (error) => {
            if (error) {
              failedPort ??= port;
              this.#drop(port);
            } else {
              for (const i of batch.indices) this.#delivered[i] = true;
              this.#count += batch.indices.length;
            }
            resolve();
          });
        }),
      );
    }
    await this.#withinStall(
      Promise.all(writes),
      () =>
        new ActuatorSourceEnded({
          kind: 'error',
          message: `control input for tick ${input.tick} did not drain within ${this.#stallMs} ms (${bytes} bytes): the firmware's socket buffers are full because it is not reading them`,
        }),
    );
    // A failed write proves nothing about how much of it arrived, and a retry could
    // run commands the firmware already received a second time: never retried.
    if (failedPort !== undefined) {
      throw (this.#failure = new ActuatorSourceEnded({
        kind: 'error',
        message: `control connection to port ${failedPort} reset during tick ${input.tick}; delivery ambiguous (the firmware may have received some of the lines, so none are resent)`,
      }));
    }
    while (this.#cursor < this.#entries.length && this.#delivered[this.#cursor]) this.#cursor += 1;
  }

  /** Waits for `promise`, but no longer than the stall timeout: then `timeout()` is thrown. */
  async #withinStall<T>(promise: Promise<T>, timeout: () => Error): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(timeout()), this.#stallMs);
    });
    try {
      return await Promise.race([promise, late]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** The connection to a firmware port, opened if needed and connected before it is used. */
  async #client(port: number, target: Target): Promise<Client> {
    let client = this.#clients.get(port);
    if (!client || client.socket.destroyed) {
      client = this.#connect(port, target);
      this.#clients.set(port, client);
    }
    if (!client.isConnected) {
      // Connecting is the kernel's job, but a wait is a wait: it gets the stall timeout.
      await this.#withinStall(
        client.connected,
        () => new ActuatorSourceEnded({ kind: 'stalled', afterMs: this.#stallMs }),
      );
    }
    return client;
  }

  #connect(port: number, target: Target): Client {
    const socket = net.connect({ host: target.bindAddress, port: target.hostPort });
    socket.setNoDelay(true);
    socket.setEncoding('utf8');
    let tail = '';
    socket.on('data', (text: string) => {
      const lines = (tail + text).split('\n');
      tail = (lines.pop() ?? '').slice(-MAX_LINE_BYTES);
      for (const line of lines) {
        this.received.push(line.replace(/\r$/, ''));
        if (this.received.length > 200) this.received.shift();
      }
    });
    // The firmware dropping us (a newer client, a reboot) is not an error here.
    socket.on('error', () => undefined);
    const client: Client = {
      socket,
      isConnected: false,
      connected: new Promise<void>((resolve, reject) => {
        socket.once('connect', () => {
          client.isConnected = true;
          resolve();
        });
        // Destroyed before it connected (by a stop, say): only 'close' says so.
        socket.once('close', () => {
          if (client.isConnected) return;
          reject(
            new ActuatorSourceEnded(
              this.#stopped
                ? { kind: 'finished' }
                : {
                    kind: 'error',
                    message: `control: the connection to firmware port ${port} closed before it was established`,
                  },
            ),
          );
        });
        socket.once('error', (error) => {
          socket.destroy();
          reject(
            new ActuatorSourceEnded({
              kind: 'error',
              message: `control: cannot connect to firmware port ${port} at ${target.bindAddress}:${target.hostPort}: ${error.message}`,
            }),
          );
        });
      }),
    };
    client.connected.catch(() => undefined);
    return client;
  }

  #drop(port: number): void {
    this.#clients.get(port)?.socket.destroy();
    this.#clients.delete(port);
  }
}

/** Wraps a firmware source so it plays `entries` into the firmware. */
export function withControlScript(
  source: ActuatorSource,
  entries: readonly ControlEntry[],
  options?: { readonly stallTimeoutMs?: number },
): ControlledSource {
  return new ControlledSource(source, entries, options);
}
