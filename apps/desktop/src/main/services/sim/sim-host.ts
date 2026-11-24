import {
  ActuatorSourceEnded,
  createFirmwareSource,
  createRun,
  killAllFirmware,
  type ActuatorSource,
  type Run,
  type RunEnd,
} from '@rcsim/sim-core';
import type { NetEvent } from '@rcsim/sim-protocol';
import type { NetMapping, RunInfo, RunSpeed } from '../../../shared/ipc.ts';
import { errorText, fail } from '../errors.ts';
import type { HostAction, HostEvent } from './host-protocol.ts';

const FRAME_MS = 16;
const PUMP_MS = 4;
const MAX_TICKS_PER_BATCH = 128;

interface Session {
  readonly run: Run;
  readonly decoder: TextDecoder;
  readonly mappings: Map<string, NetMapping>;
  info: RunInfo;
  timer: ReturnType<typeof setTimeout> | undefined;
  batch: Promise<void> | undefined;
  ending: Promise<void> | undefined;
  suspended: boolean;
  wallStart: number;
  simStartUs: number;
  lastSnapshot: number;
}

export class SimHost {
  private session: Session | undefined;
  private commands: Promise<unknown> = Promise.resolve();
  private disposed = false;

  private readonly post: (event: HostEvent) => void;
  private readonly deps: {
    readonly createSource?: (firmwarePath: string) => ActuatorSource;
    readonly now?: () => number;
  };

  constructor(post: SimHost['post'], deps: SimHost['deps'] = {}) {
    this.post = post;
    this.deps = deps;
  }

  handle(action: HostAction): Promise<unknown> {
    // Stop must be able to interrupt a stalled tick or firmware restart.
    if (action.type === 'stop' && this.session) {
      return this.finish(this.session, { kind: 'stopped' });
    }
    const pending = this.commands.then(() => this.execute(action));
    this.commands = pending.catch(() => {});
    return pending;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    killAllFirmware();
    if (this.session) await this.finish(this.session, { kind: 'stopped' });
  }

  private async execute(action: HostAction): Promise<unknown> {
    if (this.disposed) fail('no-run', 'The simulation host has closed.');
    if (action.type === 'start') return this.start(action);
    const session = this.session;
    if (!session || session.ending) {
      if (action.type === 'stop') return;
      fail('no-run', 'Start a simulation first.');
    }

    const { run } = session;
    switch (action.type) {
      case 'stop':
        return this.finish(session, { kind: 'stopped' });
      case 'pause':
        if (session.info.state === 'paused') return;
        session.suspended = true;
        clearTimeout(session.timer);
        await session.batch;
        if (session.ending) return;
        this.status(session, { state: 'paused' });
        this.snapshot(session);
        return;
      case 'resume':
        if (session.info.state === 'running') return;
        this.status(session, { state: 'running' });
        this.resumePacing(session);
        return;
      case 'step': {
        this.requirePaused(session);
        const result = await run.step(action.ticks);
        if (result.end) await this.finish(session, result.end);
        else this.snapshot(session);
        return;
      }
      case 'setSpeed':
        this.status(session, { speed: action.speed });
        this.resetPacing(session);
        if (session.info.state === 'running' && !session.suspended && !session.batch) {
          this.schedule(session);
        }
        return;
      case 'sendSerial':
        run.sendSerial(new TextEncoder().encode(action.text));
        return;
      case 'restartFirmware':
        session.suspended = true;
        clearTimeout(session.timer);
        await session.batch;
        if (session.ending) return;
        session.mappings.clear();
        this.status(session, { netMappings: [] });
        try {
          await run.restartFirmware();
        } catch (error) {
          await this.finish(session, this.failure(error));
          throw error;
        }
        if (session.info.state === 'running') this.resumePacing(session);
        return;
      case 'addObstacle': {
        this.requirePaused(session);
        const id = run.world.addObstacle(action.obstacle);
        this.snapshot(session);
        return id;
      }
      case 'moveObstacle':
        this.requirePaused(session);
        run.world.moveObstacle(action.id, action.position, action.yawDeg);
        this.snapshot(session);
        return;
      case 'removeObstacle':
        this.requirePaused(session);
        run.world.removeObstacle(action.id);
        this.snapshot(session);
        return;
      case 'currentLayout':
        this.requirePaused(session);
        return run.world.toWorldFile();
    }
  }

  private async start(action: Extract<HostAction, { type: 'start' }>): Promise<RunInfo> {
    if (this.session) fail('busy', 'A simulation is already active.');
    const source = this.deps.createSource
      ? this.deps.createSource(action.firmwarePath)
      : createFirmwareSource({ binary: action.firmwarePath });
    let run: Run;
    try {
      run = await createRun({
        car: action.car,
        catalog: action.catalog,
        track: action.track,
        world: action.world,
        seed: action.info.seed,
        ...(action.physicsStage === undefined ? {} : { physicsStage: action.physicsStage }),
        source,
      });
    } catch (error) {
      await source.stop().catch(() => {});
      this.post({
        type: 'status',
        info: { ...action.info, state: 'ended', end: this.failure(error) },
      });
      throw error;
    }
    if (this.disposed) {
      await run.stop();
      fail('no-run', 'The simulation host has closed.');
    }
    const session: Session = {
      run,
      decoder: new TextDecoder(),
      mappings: new Map(),
      info: action.info,
      timer: undefined,
      batch: undefined,
      ending: undefined,
      suspended: action.paused,
      wallStart: this.now(),
      simStartUs: 0,
      lastSnapshot: -Infinity,
    };
    this.session = session;
    run.on('serial', (bytes, tUs) => {
      const text = session.decoder.decode(bytes, { stream: true });
      if (text) this.post({ type: 'serial', text, tUs });
    });
    run.on('log', (line, tUs) => this.post({ type: 'log', line, tUs }));
    run.on('net', (event) => this.net(session, event));
    this.status(session, { state: action.paused ? 'paused' : 'running' });
    this.snapshot(session);
    if (!action.paused) this.resumePacing(session);
    return session.info;
  }

  private now(): number {
    return this.deps.now?.() ?? performance.now();
  }

  private requirePaused(session: Session): void {
    if (session.info.state !== 'paused') fail('busy', 'Pause the simulation first.');
  }

  private status(session: Session, update: Partial<RunInfo>): void {
    session.info = { ...session.info, ...update };
    this.post({ type: 'status', info: session.info });
  }

  private snapshot(session: Session): void {
    session.lastSnapshot = this.now();
    this.post({ type: 'snapshot', snapshot: session.run.snapshot() });
  }

  private resetPacing(session: Session): void {
    session.wallStart = this.now();
    session.simStartUs = session.run.clock.nowUs;
  }

  private resumePacing(session: Session): void {
    session.suspended = false;
    this.resetPacing(session);
    this.schedule(session);
  }

  private schedule(session: Session): void {
    clearTimeout(session.timer);
    session.timer = setTimeout(
      () => {
        session.timer = undefined;
        session.batch = this.pump(session).finally(() => {
          session.batch = undefined;
          if (!session.suspended) this.schedule(session);
        });
      },
      session.info.speed === 'unpaced' ? 0 : PUMP_MS,
    );
  }

  private dueTicks(session: Session, speed: RunSpeed): number {
    if (speed === 'unpaced') return MAX_TICKS_PER_BATCH;
    const targetUs = session.simStartUs + (this.now() - session.wallStart) * speed * 1000;
    return Math.min(
      MAX_TICKS_PER_BATCH,
      Math.floor((targetUs - session.run.clock.nowUs) / session.run.clock.tickUs),
    );
  }

  private async pump(session: Session): Promise<void> {
    try {
      const deadline = this.now() + FRAME_MS;
      const ticks = this.dueTicks(session, session.info.speed);
      for (let i = 0; i < ticks && !session.suspended && this.now() < deadline; i++) {
        const result = await session.run.step();
        if (result.end) {
          await this.finish(session, result.end);
          return;
        }
      }
      if (!session.suspended && this.now() - session.lastSnapshot >= FRAME_MS)
        this.snapshot(session);
    } catch (error) {
      await this.finish(session, this.failure(error));
    }
  }

  private net(session: Session, event: NetEvent): void {
    if (event.type !== 'listen' && event.type !== 'unlisten') return;
    const key = `${event.proto}:${event.firmwarePort}`;
    if (event.type === 'listen') {
      const { proto, firmwarePort, hostPort, bindAddress } = event;
      session.mappings.set(key, { proto, firmwarePort, hostPort, bindAddress });
    } else if (!session.mappings.delete(key)) {
      return;
    }
    this.status(session, { netMappings: [...session.mappings.values()] });
  }

  private failure(error: unknown): RunEnd {
    return error instanceof ActuatorSourceEnded
      ? error.end
      : { kind: 'error', message: errorText(error) };
  }

  private finish(session: Session, end: RunEnd): Promise<void> {
    session.suspended = true;
    clearTimeout(session.timer);
    session.ending ??= (async () => {
      try {
        await session.run.stop();
        const tail = session.decoder.decode();
        if (tail) this.post({ type: 'serial', text: tail, tUs: session.run.clock.nowUs });
      } finally {
        killAllFirmware();
        this.session = undefined;
        this.status(session, { state: 'ended', end, netMappings: [] });
      }
    })();
    return session.ending;
  }
}
