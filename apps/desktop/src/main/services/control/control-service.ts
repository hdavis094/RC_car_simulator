import {
  ControlClient,
  DEFAULT_PORT,
  MAX_LINE_BYTES,
  Mode,
  type ConnectionState,
  type ControlClientOptions,
  type Hello,
  type Log,
  type Telemetry,
} from '@rcsim/control-protocol';
import type { ControlApi, ControlTarget, RunInfo, Unsubscribe } from '../../../shared/ipc.ts';
import { fail } from '../errors.ts';
import { Signal } from '../events.ts';
import { ControlWire } from './control-wire.ts';

type Address = Extract<ControlTarget, { kind: 'host' }>;
type TargetSelection = 'run' | 'host' | 'disconnected';

interface Link {
  readonly target: Address;
  readonly wire: ControlWire;
  readonly opening: Promise<void>;
  client?: ControlClient;
}

export class ControlService implements ControlApi {
  private readonly states = new Signal<[ConnectionState]>();
  private readonly messages = new Signal<[Hello | Telemetry | Log]>();
  private readonly raw = new Signal<[string, 'in' | 'out']>();
  readonly onState = this.states.subscribe;
  readonly onMessage = this.messages.subscribe;
  readonly onRaw = this.raw.subscribe;

  private selection: TargetSelection = 'run';
  private run: RunInfo | undefined;
  private state: ConnectionState = 'idle';
  private link: Link | undefined;
  private readonly offRun: Unsubscribe;

  private readonly deps: {
    readonly onRunStatus: (listener: (info: RunInfo) => void) => Unsubscribe;
    readonly createClient?: (options: ControlClientOptions) => ControlClient;
  };

  constructor(deps: ControlService['deps']) {
    this.deps = deps;
    this.offRun = deps.onRunStatus((info) => {
      if (info.runId !== this.run?.runId && this.selection === 'disconnected') {
        this.selection = 'run';
      }
      this.run = info;
      if (this.selection === 'run') {
        void this.followRun().catch(() => {});
      }
    });
  }

  async connect(target: ControlTarget): Promise<void> {
    if (target?.kind === 'run') {
      if (this.selection === 'host') {
        this.closeLink();
      }
      this.selection = 'run';
      await this.followRun();
      return;
    }
    if (
      target?.kind !== 'host' ||
      typeof target.host !== 'string' ||
      !target.host.trim() ||
      !Number.isInteger(target.port) ||
      target.port < 1 ||
      target.port > 65535
    ) {
      fail('invalid', 'Expected a host and a TCP port between 1 and 65535.');
    }
    this.selection = 'host';
    await this.open({ kind: 'host', host: target.host.trim(), port: target.port });
  }

  async disconnect(): Promise<void> {
    this.selection = 'disconnected';
    this.closeLink();
  }

  reset(): void {
    this.closeLink();
    this.selection = 'run';
  }

  dispose(): void {
    this.offRun();
    this.reset();
  }

  async drive(command: { throttle: number; steer: number }): Promise<boolean> {
    if (!command || !Number.isFinite(command.throttle) || !Number.isFinite(command.steer)) {
      fail('invalid', 'Expected finite throttle and steering commands.');
    }
    return this.connectedClient()?.drive(command) ?? false;
  }

  async releaseDrive(): Promise<void> {
    this.link?.client?.releaseDrive();
  }

  async setMode(mode: Mode): Promise<boolean> {
    if (!Mode.safeParse(mode).success) fail('invalid', 'Unknown driving mode.');
    return this.connectedClient()?.setMode(mode) ?? false;
  }

  async estop(): Promise<boolean> {
    this.link?.client?.releaseDrive();
    return this.connectedClient()?.estop() ?? false;
  }

  async sendRaw(line: string): Promise<boolean> {
    if (!this.connectedClient()) return false;
    if (
      typeof line !== 'string' ||
      /[\r\n]/.test(line) ||
      Buffer.byteLength(line) + 1 > MAX_LINE_BYTES
    ) {
      fail('invalid', `Expected one line of at most ${MAX_LINE_BYTES - 1} bytes.`);
    }
    return this.link?.wire.sendRaw(line) ?? false;
  }

  private connectedClient(): ControlClient | undefined {
    return this.state === 'connected' && this.link?.wire.ready ? this.link.client : undefined;
  }

  private async followRun(): Promise<void> {
    const mapping =
      this.run?.state !== 'ended' &&
      this.run?.netMappings.find(
        (entry) => entry.proto === 'tcp' && entry.firmwarePort === DEFAULT_PORT,
      );
    if (!mapping) {
      this.closeLink();
      return;
    }
    await this.open({ kind: 'host', host: '127.0.0.1', port: mapping.hostPort });
  }

  private open(target: Address): Promise<void> {
    if (this.link?.target.host === target.host && this.link.target.port === target.port) {
      return this.link.opening;
    }
    this.closeLink();
    const opened = Promise.withResolvers<void>();
    const publishReady = (): void => {
      if (this.link === link && link.client?.state === 'connected' && link.wire.ready) {
        this.setState('connected');
      }
    };
    const wire = new ControlWire(
      target,
      (line, direction) => {
        if (this.link === link) this.raw.emit(line, direction);
      },
      publishReady,
    );
    const link: Link = { target, wire, opening: opened.promise };
    this.link = link;
    this.setState('connecting');
    void wire
      .listen()
      .then((port) => {
        if (this.link !== link) return;
        const options: ControlClientOptions = {
          host: '127.0.0.1',
          port,
          // A paused simulation legitimately stops sending telemetry.
          ...(this.selection === 'run' ? { silenceTimeoutMs: 2_147_483_647 } : {}),
        };
        const client = this.deps.createClient?.(options) ?? new ControlClient(options);
        link.client = client;
        client.on('state', (state) => {
          if (this.link !== link) return;
          if (state === 'connected') publishReady();
          else this.setState(state);
        });
        const onMessage = (message: Hello | Telemetry | Log): void => {
          if (this.link === link) this.messages.emit(message);
        };
        client.on('hello', onMessage).on('telemetry', onMessage).on('log', onMessage);
        client.connect();
      })
      .then(opened.resolve, (error: unknown) => {
        if (this.link === link) this.closeLink();
        opened.reject(error);
      });
    return opened.promise;
  }

  private closeLink(): void {
    const link = this.link;
    this.link = undefined;
    if (!link) return;
    link.client?.close();
    link.wire.close();
    this.setState('closed');
  }

  private setState(state: ConnectionState): void {
    if (state === this.state) return;
    this.state = state;
    this.states.emit(state);
  }
}
