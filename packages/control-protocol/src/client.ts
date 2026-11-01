import { EventEmitter } from 'node:events';
import { Socket } from 'node:net';
import { LineSplitter } from './lines.ts';
import {
  DEFAULT_PORT,
  encodeLine,
  parseCarLine,
  type ClientMessage,
  type Hello,
  type Log,
  type Mode,
  type Telemetry,
} from './messages.ts';

export type ConnectionState = 'idle' | 'connecting' | 'connected' | 'waiting' | 'closed';

export interface ReconnectOptions {
  /** First delay after a failed or lost connection. */
  readonly initialMs: number;
  /** Ceiling for the delay. */
  readonly maxMs: number;
  /** Growth per consecutive failure. */
  readonly factor: number;
}

export interface ControlClientOptions {
  readonly host: string;
  readonly port?: number;
  readonly reconnect?: Partial<ReconnectOptions>;
  /** How often a held drive command is resent, well inside the 500 ms failsafe. */
  readonly driveRepeatMs?: number;
}

export interface ControlClientEvents {
  state: [state: ConnectionState];
  hello: [hello: Hello];
  telemetry: [telemetry: Telemetry];
  log: [log: Log];
  /** A line the client ignored: invalid JSON, an unknown type, or too long. */
  unknown: [detail: { line: string; reason: string }];
  /** A socket error. The client reconnects on its own; this is for display. */
  error: [error: Error];
}

export const DEFAULT_RECONNECT: ReconnectOptions = { initialMs: 250, maxMs: 5000, factor: 2 };

const clampUnit = (v: number): number => (Number.isFinite(v) ? Math.min(1, Math.max(-1, v)) : 0);

/**
 * A control-protocol client for a car, real or simulated. It reconnects with
 * exponential backoff until `close()`, and resends a held drive command every
 * `driveRepeatMs` so the car's failsafe stays off while a person is driving.
 * Commands sent while disconnected are dropped, not queued: a stale drive
 * command must never reach the car late.
 */
export class ControlClient extends EventEmitter<ControlClientEvents> {
  readonly host: string;
  readonly port: number;
  readonly #reconnect: ReconnectOptions;
  readonly #driveRepeatMs: number;

  #state: ConnectionState = 'idle';
  #socket: Socket | undefined;
  #retryTimer: NodeJS.Timeout | undefined;
  #repeatTimer: NodeJS.Timeout | undefined;
  #failures = 0;
  #seq = 0;
  #held: { throttle: number; steer: number } | undefined;
  #hello: Hello | undefined;
  #telemetry: Telemetry | undefined;

  constructor(options: ControlClientOptions) {
    super();
    this.host = options.host;
    this.port = options.port ?? DEFAULT_PORT;
    this.#reconnect = { ...DEFAULT_RECONNECT, ...options.reconnect };
    this.#driveRepeatMs = options.driveRepeatMs ?? 100;
  }

  get state(): ConnectionState {
    return this.#state;
  }

  /** The car's `hello` on the current connection. */
  get hello(): Hello | undefined {
    return this.#hello;
  }

  get lastTelemetry(): Telemetry | undefined {
    return this.#telemetry;
  }

  /** Starts connecting; afterwards the client keeps itself connected until `close()`. */
  connect(): void {
    if (this.#state !== 'idle') return;
    this.#open();
  }

  /** Sends a drive command now and keeps resending it until `releaseDrive()`. */
  drive(command: { throttle: number; steer: number }): boolean {
    this.#held = { throttle: clampUnit(command.throttle), steer: clampUnit(command.steer) };
    if (!this.#repeatTimer) {
      this.#repeatTimer = setInterval(() => this.#sendHeld(), this.#driveRepeatMs);
    }
    return this.#sendHeld();
  }

  /** Stops resending; the car failsafes 500 ms after the last command in manual mode. */
  releaseDrive(): void {
    this.#held = undefined;
    clearInterval(this.#repeatTimer);
    this.#repeatTimer = undefined;
  }

  setMode(mode: Mode): boolean {
    return this.#send({ t: 'mode', mode });
  }

  estop(): boolean {
    return this.#send({ t: 'estop' });
  }

  /** Disconnects and stops reconnecting. */
  close(): void {
    this.releaseDrive();
    clearTimeout(this.#retryTimer);
    this.#retryTimer = undefined;
    this.#socket?.destroy();
    this.#socket = undefined;
    this.#setState('closed');
  }

  #sendHeld(): boolean {
    if (!this.#held) return false;
    const message: ClientMessage = { t: 'drive', seq: this.#seq, ...this.#held };
    const sent = this.#send(message);
    if (sent) this.#seq = (this.#seq + 1) % 0x1_0000_0000;
    return sent;
  }

  #send(message: ClientMessage): boolean {
    if (this.#state !== 'connected' || !this.#socket) return false;
    this.#socket.write(encodeLine(message));
    return true;
  }

  #setState(state: ConnectionState): void {
    if (this.#state === state) return;
    this.#state = state;
    this.emit('state', state);
  }

  #open(): void {
    this.#setState('connecting');
    const socket = new Socket();
    this.#socket = socket;
    const splitter = new LineSplitter((bytes) =>
      this.emit('unknown', { line: '', reason: `line of ${bytes} bytes is over the limit` }),
    );
    socket.setNoDelay(true);

    socket.on('connect', () => {
      if (this.#socket !== socket) return;
      this.#failures = 0;
      this.#hello = undefined;
      this.#setState('connected');
      this.#sendHeld();
    });
    socket.on('data', (chunk: Buffer) => {
      if (this.#socket !== socket) return;
      for (const line of splitter.push(chunk)) this.#handle(line);
    });
    socket.on('error', (error) => {
      if (this.#socket === socket && this.listenerCount('error') > 0) this.emit('error', error);
    });
    socket.on('close', () => {
      if (this.#socket !== socket) return;
      this.#socket = undefined;
      if (this.#state === 'closed') return;
      this.#scheduleRetry();
    });
    socket.connect(this.port, this.host);
  }

  #scheduleRetry(): void {
    const { initialMs, maxMs, factor } = this.#reconnect;
    const delay = Math.min(maxMs, initialMs * factor ** this.#failures);
    this.#failures += 1;
    this.#setState('waiting');
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = undefined;
      if (this.#state === 'waiting') this.#open();
    }, delay);
  }

  #handle(line: string): void {
    const parsed = parseCarLine(line);
    if (!parsed.ok) {
      this.emit('unknown', { line: parsed.line, reason: parsed.reason });
      return;
    }
    const message = parsed.message;
    switch (message.t) {
      case 'hello':
        this.#hello = message;
        this.emit('hello', message);
        break;
      case 'telemetry':
        this.#telemetry = message;
        this.emit('telemetry', message);
        break;
      case 'log':
        this.emit('log', message);
        break;
    }
  }
}
