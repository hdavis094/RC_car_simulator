import { randomUUID } from 'node:crypto';
import { checkWiring, generateCarConfigHeader, type Obstacle, type World } from '@rcsim/schema';
import type { StateSnapshot } from '@rcsim/sim-core';
import type { LogLine, NetFaults } from '@rcsim/sim-protocol';
import {
  RUN_SPEEDS,
  type BuildApi,
  type BuildEvent,
  type CatalogApi,
  type RunApi,
  type RunInfo,
  type RunSpeed,
  type RunStartOptions,
} from '../../../shared/ipc.ts';
import { errorText, fail } from '../errors.ts';
import { Signal } from '../events.ts';
import type { ProjectService } from '../project.ts';
import { loadTrack, parseWorld, readWorld, requireLayoutPath } from '../world-edit/world-files.ts';
import type { HostAction, HostChannel, HostEvent } from './host-protocol.ts';

interface PendingRequest {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
}

export class SimService implements RunApi {
  private readonly snapshots = new Signal<[StateSnapshot]>();
  private readonly serial = new Signal<[string, number]>();
  private readonly logs = new Signal<[LogLine, number]>();
  private readonly statuses = new Signal<[RunInfo]>();
  readonly onSnapshot = this.snapshots.subscribe;
  readonly onSerial = this.serial.subscribe;
  readonly onLog = this.logs.subscribe;
  readonly onStatus = this.statuses.subscribe;

  private current: RunInfo | null = null;
  private starting: AbortController | undefined;
  private host: { readonly channel: HostChannel; readonly unsubscribe: () => void } | undefined;
  private readonly pending = new Map<number, PendingRequest>();
  private nextRequestId = 0;

  private readonly deps: {
    readonly project: Pick<
      ProjectService,
      'requireProject' | 'readCar' | 'readFile' | 'writeFile' | 'resolvePath'
    >;
    readonly catalog: Pick<CatalogApi, 'list'>;
    readonly build: BuildApi;
    readonly spawnHost: () => HostChannel;
  };

  constructor(deps: SimService['deps']) {
    this.deps = deps;
  }

  async start(options: RunStartOptions): Promise<RunInfo> {
    if (this.starting || this.active()) fail('busy', 'A simulation is already active.');
    const { project, catalog } = this.deps;
    const dir = project.requireProject().dir;
    if (
      !options ||
      !Number.isInteger(options.seed) ||
      options.seed < 0 ||
      options.seed > 0xffff_ffff
    ) {
      fail('invalid', 'Expected an unsigned 32-bit seed.');
    }
    const speed = options.speed ?? 1;
    this.checkSpeed(speed);
    if (options.paused !== undefined && typeof options.paused !== 'boolean') {
      fail('invalid', 'Expected a boolean paused setting.');
    }

    const start = new AbortController();
    this.starting = start;
    const info: RunInfo = {
      runId: randomUUID(),
      state: 'starting',
      trackId: '',
      speed,
      seed: options.seed,
      end: null,
      netMappings: [],
    };
    this.setStatus(info);
    const checkProject = (): void => {
      start.signal.throwIfAborted();
      if (project.requireProject().dir !== dir)
        fail('no-project', 'The car project changed during startup.');
    };
    try {
      let world: World;
      if (typeof options.world === 'string') {
        requireLayoutPath(options.world);
        world = readWorld(await project.readFile(options.world, 'worlds'));
      } else {
        world = parseWorld(options.world);
      }
      const track = loadTrack(world.trackId);
      const [carResult, listing] = await Promise.all([project.readCar(), catalog.list()]);
      checkProject();
      if (!carResult.ok) fail('wiring-errors', carResult.error);
      const { car } = carResult;
      const parts = new Map(
        [...listing.builtIn, ...listing.custom.map((part) => part.definition)].map(
          (definition) => [definition.id, definition] as const,
        ),
      );
      const errors = checkWiring(car, parts).filter((issue) => issue.severity === 'error');
      if (errors.length) fail('wiring-errors', errors.map((issue) => issue.message).join('\n'));
      await project.writeFile('include/car_config.h', generateCarConfigHeader(car, parts));
      checkProject();
      await this.build(start.signal);
      checkProject();
      const firmwarePath = await project.resolvePath('.rcsim/build/firmware');
      checkProject();
      const result = await this.send({
        type: 'start',
        info: { ...info, trackId: world.trackId },
        car,
        catalog: parts,
        world: { ...world, seed: options.seed },
        track,
        firmwarePath,
        paused: options.paused ?? false,
      });
      start.signal.throwIfAborted();
      return result as RunInfo;
    } catch (error) {
      if (this.current?.runId === info.runId && this.current.state !== 'ended') {
        const end = start.signal.aborted
          ? { kind: 'stopped' as const }
          : { kind: 'error' as const, message: errorText(error) };
        this.setStatus({ ...this.current, state: 'ended', end, netMappings: [] });
      }
      throw error;
    } finally {
      if (this.starting === start) this.starting = undefined;
    }
  }

  private async build(signal: AbortSignal): Promise<void> {
    const { build } = this.deps;
    const completed = new Map<string, Extract<BuildEvent, { kind: 'done' }>>();
    const result = Promise.withResolvers<Extract<BuildEvent, { kind: 'done' }>>();
    let buildId: string | undefined;
    const unsubscribe = build.onEvent((event) => {
      if (event.kind !== 'done') return;
      if (event.buildId === buildId) result.resolve(event);
      else if (buildId === undefined) completed.set(event.buildId, event);
    });
    const abort = (): void => {
      if (buildId) void build.cancel(buildId).catch(() => {});
      result.reject(signal.reason);
    };
    // An abort can occur before build.start supplies its id.
    void result.promise.catch(() => {});
    signal.addEventListener('abort', abort, { once: true });
    try {
      ({ buildId } = await build.start('sim'));
      if (signal.aborted) abort();
      signal.throwIfAborted();
      const done = completed.get(buildId) ?? (await result.promise);
      if (!done.ok) {
        const detail = done.diagnostics[0]?.message ?? 'See build output in the Terminal.';
        fail('build-failed', detail);
      }
    } catch (error) {
      signal.throwIfAborted();
      if (errorText(error).includes('[rcsim:build-failed]')) throw error;
      fail('build-failed', errorText(error));
    } finally {
      unsubscribe();
      signal.removeEventListener('abort', abort);
    }
  }

  async stop(): Promise<void> {
    if (this.starting && this.current?.state === 'starting') {
      this.dispose();
    } else if (this.active()) {
      await this.send({ type: 'stop' });
    }
  }

  async pause(): Promise<void> {
    await this.sendActive({ type: 'pause' });
  }
  async resume(): Promise<void> {
    await this.sendActive({ type: 'resume' });
  }

  async step(ticks = 1): Promise<void> {
    if (!Number.isSafeInteger(ticks) || ticks < 1)
      fail('invalid', 'Expected a positive tick count.');
    await this.sendActive({ type: 'step', ticks });
  }

  async restartFirmware(): Promise<void> {
    await this.sendActive({ type: 'restartFirmware' });
  }

  async setSpeed(speed: RunSpeed): Promise<void> {
    this.checkSpeed(speed);
    await this.sendActive({ type: 'setSpeed', speed });
  }

  async setNetFaults(faults: NetFaults): Promise<void> {
    if (!faults || typeof faults !== 'object' || Array.isArray(faults)) {
      fail('invalid', 'Expected network fault settings.');
    }
    const { latencyUs, lossPpm, dropout } = faults;
    if (
      typeof latencyUs !== 'number' ||
      !Number.isInteger(latencyUs) ||
      latencyUs < 0 ||
      latencyUs > 0xffff_ffff
    ) {
      fail('invalid', 'Expected latencyUs as an unsigned 32-bit integer.');
    }
    if (
      typeof lossPpm !== 'number' ||
      !Number.isInteger(lossPpm) ||
      lossPpm < 0 ||
      lossPpm > 1_000_000
    ) {
      fail('invalid', 'Expected lossPpm as an integer between 0 and 1000000.');
    }
    if (typeof dropout !== 'boolean') {
      fail('invalid', 'Expected dropout as a boolean.');
    }
    await this.sendActive({
      type: 'setNetFaults',
      faults: {
        latencyUs: latencyUs === 0 ? 0 : latencyUs,
        lossPpm: lossPpm === 0 ? 0 : lossPpm,
        dropout,
      },
    });
  }

  private checkSpeed(speed: RunSpeed): void {
    if (!RUN_SPEEDS.includes(speed)) fail('invalid', 'Unknown simulation speed.');
  }

  async info(): Promise<RunInfo | null> {
    return this.current;
  }

  async sendSerial(text: string): Promise<void> {
    if (typeof text !== 'string') fail('invalid', 'Expected serial text.');
    await this.sendActive({ type: 'sendSerial', text });
  }

  async addObstacle(obstacle: Obstacle): Promise<string> {
    return (await this.sendActive({ type: 'addObstacle', obstacle })) as string;
  }

  async moveObstacle(
    id: string,
    position: { x: number; z: number },
    yawDeg: number,
  ): Promise<void> {
    await this.sendActive({ type: 'moveObstacle', id, position, yawDeg });
  }

  async removeObstacle(id: string): Promise<void> {
    await this.sendActive({ type: 'removeObstacle', id });
  }

  async currentLayout(): Promise<World> {
    return (await this.sendActive({ type: 'currentLayout' })) as World;
  }

  private active(): boolean {
    return this.current !== null && this.current.state !== 'ended';
  }

  private async sendActive(action: HostAction): Promise<unknown> {
    if (!this.current || this.current.state === 'ended')
      fail('no-run', 'Start a simulation first.');
    if (this.current.state === 'starting') fail('busy', 'The simulation is starting.');
    return this.send(action);
  }

  private setStatus(info: RunInfo): void {
    this.current = info;
    this.statuses.emit(info);
  }

  private getHost(): HostChannel {
    if (this.host) return this.host.channel;
    const channel = this.deps.spawnHost();
    const offMessage = channel.onMessage((event) => this.receive(event));
    const offExit = channel.onExit(() => {
      this.releaseHost(new Error('The simulation host exited unexpectedly.'));
      if (this.current && this.active()) {
        this.setStatus({
          ...this.current,
          state: 'ended',
          netMappings: [],
          end: { kind: 'error', message: 'The simulation host exited unexpectedly.' },
        });
      }
    });
    this.host = {
      channel,
      unsubscribe: () => {
        offMessage();
        offExit();
      },
    };
    return channel;
  }

  private async send(action: HostAction): Promise<unknown> {
    const channel = this.getHost();
    const requestId = ++this.nextRequestId;
    const reply = Promise.withResolvers<unknown>();
    this.pending.set(requestId, reply);
    try {
      channel.send({ ...action, requestId });
      return await reply.promise;
    } finally {
      this.pending.delete(requestId);
    }
  }

  private receive(event: HostEvent): void {
    switch (event.type) {
      case 'reply':
        if (event.ok) this.pending.get(event.requestId)?.resolve(event.value);
        else this.pending.get(event.requestId)?.reject(new Error(event.error));
        break;
      case 'status':
        this.setStatus(event.info);
        break;
      case 'snapshot':
        this.snapshots.emit(event.snapshot);
        break;
      case 'serial':
        this.serial.emit(event.text, event.tUs);
        break;
      case 'log':
        this.logs.emit(event.line, event.tUs);
        break;
    }
  }

  private releaseHost(error: Error): HostChannel | undefined {
    const host = this.host;
    this.host = undefined;
    host?.unsubscribe();
    for (const reply of this.pending.values()) reply.reject(error);
    this.pending.clear();
    return host?.channel;
  }

  dispose(): void {
    const error = new Error('The simulation was stopped.');
    this.starting?.abort(error);
    this.releaseHost(error)?.kill();
    if (this.current && this.active()) {
      this.setStatus({
        ...this.current,
        state: 'ended',
        end: { kind: 'stopped' },
        netMappings: [],
      });
    }
  }
}
