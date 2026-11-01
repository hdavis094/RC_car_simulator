import { EventEmitter } from 'node:events';
import { createServer, type Server, type Socket } from 'node:net';
import { LineSplitter } from './lines.ts';
import {
  FAILSAFE_MS,
  PROTOCOL_VERSION,
  TELEMETRY_INTERVAL_MS,
  encodeLine,
  isNewerSeq,
  parseClientLine,
  type CarMessage,
  type ClientMessage,
  type Mode,
} from './messages.ts';

export interface FakeCarOptions {
  /** 0 picks a free port. */
  readonly port?: number;
  readonly host?: string;
  readonly name?: string;
  readonly fw?: string;
  readonly telemetryIntervalMs?: number;
  readonly failsafeMs?: number;
}

export interface FakeCarState {
  mode: Mode;
  estop: boolean;
  throttle: number;
  steer: number;
  /** The car stopped itself because drive commands stopped arriving. */
  failsafe: boolean;
}

export interface FakeCarEvents {
  connection: [];
  command: [message: ClientMessage];
  /** The failsafe fired; `sinceLastDriveMs` is wall time since the last applied drive. */
  failsafe: [sinceLastDriveMs: number];
  /** A line the car ignored and logged. */
  ignored: [line: string, reason: string];
}

/**
 * A car that speaks the control protocol exactly as SPEC.md describes,
 * without physics: it applies drive commands, mode changes, e-stop and the
 * failsafe, and streams telemetry. For tests of anything that talks to a car.
 */
export class FakeCar extends EventEmitter<FakeCarEvents> {
  readonly state: FakeCarState = {
    mode: 'manual',
    estop: false,
    throttle: 0,
    steer: 0,
    failsafe: false,
  };
  /** Every valid command received, in order. */
  readonly received: ClientMessage[] = [];

  readonly #server: Server;
  readonly #options: Required<Omit<FakeCarOptions, 'port' | 'host'>>;
  readonly #startedAt = performance.now();
  #client: Socket | undefined;
  #lastSeq: number | undefined;
  #lastDriveAt: number | undefined;
  #failsafeTimer: NodeJS.Timeout | undefined;
  #telemetryTimer: NodeJS.Timeout | undefined;

  private constructor(server: Server, options: FakeCarOptions) {
    super();
    this.#server = server;
    this.#options = {
      name: options.name ?? 'Fake car',
      fw: options.fw ?? '0.0.0-fake',
      telemetryIntervalMs: options.telemetryIntervalMs ?? TELEMETRY_INTERVAL_MS,
      failsafeMs: options.failsafeMs ?? FAILSAFE_MS,
    };
    server.on('connection', (socket) => this.#accept(socket));
    this.#telemetryTimer = setInterval(
      () => this.#sendTelemetry(),
      this.#options.telemetryIntervalMs,
    );
  }

  static async start(options: FakeCarOptions = {}): Promise<FakeCar> {
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(options.port ?? 0, options.host ?? '127.0.0.1', () => resolve());
    });
    return new FakeCar(server, options);
  }

  get port(): number {
    const address = this.#server.address();
    if (address === null || typeof address === 'string') throw new Error('not listening');
    return address.port;
  }

  get connected(): boolean {
    return this.#client !== undefined;
  }

  /** Sends a raw line to the client, for testing how clients treat odd input. */
  sendRaw(line: string): void {
    this.#client?.write(line.endsWith('\n') ? line : `${line}\n`);
  }

  log(msg: string): void {
    this.#write({ t: 'log', msg });
  }

  /** Drops the current client, as a Wi-Fi dropout would. */
  dropClient(): void {
    this.#client?.destroy();
    this.#client = undefined;
  }

  async stop(): Promise<void> {
    clearInterval(this.#telemetryTimer);
    clearTimeout(this.#failsafeTimer);
    this.dropClient();
    await new Promise<void>((resolve) => this.#server.close(() => resolve()));
  }

  #accept(socket: Socket): void {
    this.#client?.destroy(); // the newest controller wins
    this.#client = socket;
    this.#lastSeq = undefined;
    socket.setNoDelay(true);
    const splitter = new LineSplitter((bytes) => {
      this.log(`ignored a line of ${bytes} bytes (over the limit)`);
      this.emit('ignored', '', 'too long');
    });
    socket.on('data', (chunk: Buffer) => {
      for (const line of splitter.push(chunk)) this.#handle(line);
    });
    socket.on('error', () => {});
    socket.on('close', () => {
      if (this.#client === socket) this.#client = undefined;
    });
    this.#write({
      t: 'hello',
      name: this.#options.name,
      fw: this.#options.fw,
      proto: PROTOCOL_VERSION,
    });
    this.emit('connection');
  }

  #handle(line: string): void {
    const parsed = parseClientLine(line);
    if (!parsed.ok) {
      this.log(`ignored: ${parsed.reason}`);
      this.emit('ignored', parsed.line, parsed.reason);
      return;
    }
    const message = parsed.message;
    this.received.push(message);
    this.emit('command', message);
    switch (message.t) {
      case 'drive':
        if (this.state.estop || this.state.mode !== 'manual') return;
        if (!isNewerSeq(message.seq, this.#lastSeq)) return;
        this.#lastSeq = message.seq;
        this.state.throttle = message.throttle;
        this.state.steer = message.steer;
        this.state.failsafe = false;
        this.#lastDriveAt = performance.now();
        this.#armFailsafe();
        return;
      case 'mode':
        this.state.mode = message.mode;
        this.state.estop = false;
        if (message.mode === 'manual') this.#armFailsafe();
        else clearTimeout(this.#failsafeTimer);
        return;
      case 'estop':
        this.state.estop = true;
        this.state.throttle = 0;
        clearTimeout(this.#failsafeTimer);
        return;
    }
  }

  #armFailsafe(): void {
    clearTimeout(this.#failsafeTimer);
    this.#failsafeTimer = setTimeout(() => {
      if (this.state.mode !== 'manual' || this.state.estop) return;
      this.state.throttle = 0;
      this.state.steer = 0;
      this.state.failsafe = true;
      this.log(`failsafe: no drive for ${this.#options.failsafeMs} ms`);
      this.emit('failsafe', performance.now() - (this.#lastDriveAt ?? this.#startedAt));
    }, this.#options.failsafeMs);
  }

  #sendTelemetry(): void {
    this.#write({
      t: 'telemetry',
      ms: Math.floor(performance.now() - this.#startedAt),
      mode: this.state.mode,
      estop: this.state.estop,
      throttle: this.state.throttle,
      steer: this.state.steer,
    });
  }

  #write(message: CarMessage): void {
    this.#client?.write(encodeLine(message));
  }
}
