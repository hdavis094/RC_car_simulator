import net from 'node:net';
import { ClientMessage, DEFAULT_PORT, MAX_LINE_BYTES } from '@rcsim/control-protocol/messages';
import {
  ActuatorSourceEnded,
  type ActuatorSource,
  type ActuatorSourceSetup,
  type TickInput,
  type TickOutput,
} from '../api/actuator-source.ts';

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
 * `drive` has its `seq` raised by one each time. Entries are sent in time order.
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
        ? JSON.stringify({ ...message, seq: (message.seq as number) + n })
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

/**
 * An `ActuatorSource` that plays a control timeline into the firmware it
 * wraps. Each entry is written to the firmware's TCP server (found through its
 * LISTEN net event, so the host port hal picked doesn't matter) just before
 * the tick that contains its time, and every other call passes through.
 *
 * An entry whose port isn't listening yet waits, and so does everything after
 * it. The car's replies (hello, telemetry) are read and kept in `received`.
 */
export class ControlledSource implements ActuatorSource {
  /** The last lines the firmware sent back over its control connections. */
  readonly received: string[] = [];
  readonly #inner: ActuatorSource;
  readonly #entries: readonly ControlEntry[];
  #next = 0;
  readonly #listening = new Map<number, { hostPort: number; bindAddress: string }>();
  readonly #clients = new Map<number, net.Socket>();

  constructor(inner: ActuatorSource, entries: readonly ControlEntry[]) {
    this.#inner = inner;
    this.#entries = entries;
  }

  /** Lines still waiting to be sent. */
  get pending(): number {
    return this.#entries.length - this.#next;
  }

  start(setup: ActuatorSourceSetup): Promise<void> {
    return this.#inner.start(setup);
  }

  async step(input: TickInput): Promise<TickOutput> {
    while (this.#next < this.#entries.length) {
      const entry = this.#entries[this.#next] as ControlEntry;
      if (entry.tUs >= input.t1Us) break;
      const target = this.#listening.get(entry.port);
      if (!target) break;
      const client = await this.#client(entry.port, target);
      await new Promise<void>((resolve, reject) => {
        client.write(`${entry.line}\n`, (error) => (error ? reject(error) : resolve()));
      }).catch((error: Error) => {
        throw new ActuatorSourceEnded({
          kind: 'error',
          message: `control: cannot send to firmware port ${entry.port}: ${error.message}`,
        });
      });
      this.#next += 1;
    }
    const output = await this.#inner.step(input);
    for (const event of output.netEvents) {
      if (event.type === 'listen' && event.proto === 'tcp') {
        this.#listening.set(event.firmwarePort, {
          hostPort: event.hostPort,
          bindAddress: event.bindAddress,
        });
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
    for (const port of [...this.#clients.keys()]) this.#drop(port);
    await this.#inner.stop();
  }

  async #client(
    port: number,
    target: { hostPort: number; bindAddress: string },
  ): Promise<net.Socket> {
    const existing = this.#clients.get(port);
    if (existing && !existing.destroyed) return existing;
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
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
    }).catch((error: Error) => {
      socket.destroy();
      throw new ActuatorSourceEnded({
        kind: 'error',
        message: `control: cannot connect to firmware port ${port} at ${target.bindAddress}:${target.hostPort}: ${error.message}`,
      });
    });
    this.#clients.set(port, socket);
    return socket;
  }

  #drop(port: number): void {
    this.#clients.get(port)?.destroy();
    this.#clients.delete(port);
  }
}

/** Wraps a firmware source so it plays `entries` into the firmware. */
export function withControlScript(
  source: ActuatorSource,
  entries: readonly ControlEntry[],
): ControlledSource {
  return new ControlledSource(source, entries);
}
