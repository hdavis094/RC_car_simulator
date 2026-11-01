// An in-memory RcsimApi for renderer tests and for building a view before
// main implements its service (P0-05). No Node, no Electron: safe to import
// from renderer code and from Vitest with jsdom.

import type { ConnectionState, Hello, Log, Telemetry } from '@rcsim/control-protocol/messages';
import type { StateSnapshot } from '@rcsim/sim-core/api';
import type { LogLine } from '@rcsim/sim-protocol';
import {
  Car,
  DEFAULT_CATALOG_ENTRIES,
  PartDefinition,
  World,
  createCatalog,
  defaultCatalog,
  exampleCar,
  generateCarConfigHeader,
  type CatalogProblem,
  type World as WorldFile,
} from '@rcsim/schema';
import {
  ipcErrorMessage,
  type BuildEvent,
  type CatalogListing,
  type Diagnostic,
  type FileChange,
  type ProjectInfo,
  type RcsimApi,
  type RunInfo,
  type RunSpeed,
  type ServiceName,
} from './ipc.ts';

type Listeners<T extends unknown[]> = Set<(...args: T) => void>;

const subscribe = <T extends unknown[]>(set: Listeners<T>, listener: (...args: T) => void) => {
  set.add(listener);
  return () => {
    set.delete(listener);
  };
};

const fire = <T extends unknown[]>(set: Listeners<T>, ...args: T): void => {
  for (const listener of set) listener(...args);
};

/** One recorded API call. */
export interface FakeCall {
  readonly service: ServiceName;
  readonly method: string;
  readonly args: readonly unknown[];
}

export interface FakeApiOptions {
  /** Project files by project-relative path. Default: the example car, its header and a stub sketch. */
  readonly files?: Record<string, string>;
  readonly dir?: string;
  /** Diagnostics the next builds report (empty = success). */
  readonly buildDiagnostics?: readonly Diagnostic[];
  readonly platform?: RcsimApi['platform'];
}

/** The fake API plus handles for tests to drive and inspect it. */
export interface FakeApi {
  readonly api: RcsimApi;
  /** Every call, in order. */
  readonly calls: FakeCall[];
  /** The in-memory project files. */
  readonly files: Map<string, string>;
  /** Push events as main would. */
  readonly emit: {
    fileChange(change: FileChange): void;
    snapshot(snapshot: StateSnapshot): void;
    serial(text: string, tUs?: number): void;
    controlState(state: ConnectionState): void;
    controlMessage(message: Hello | Telemetry | Log): void;
    ptyData(ptyId: string, data: string): void;
  };
  setBuildDiagnostics(diagnostics: readonly Diagnostic[]): void;
}

const DEFAULT_FILES = (): Record<string, string> => ({
  'car.json': `${JSON.stringify(exampleCar, null, 2)}\n`,
  'include/car_config.h': generateCarConfigHeader(exampleCar, defaultCatalog),
  'src/main.cpp': '#include <Arduino.h>\n\nvoid setup() {}\n\nvoid loop() {}\n',
  'platformio.ini':
    '[env:esp32dev]\nplatform = espressif32\nboard = esp32dev\nframework = arduino\n',
});

export function createFakeRcsimApi(options: FakeApiOptions = {}): FakeApi {
  const files = new Map(Object.entries(options.files ?? DEFAULT_FILES()));
  const calls: FakeCall[] = [];
  const dir = options.dir ?? '/projects/fake-car';
  let buildDiagnostics = options.buildDiagnostics ?? [];
  let project: ProjectInfo | null = { dir, name: 'Fake car' };
  let nextId = 1;

  const ev = {
    fileChange: new Set() as Listeners<[FileChange]>,
    catalog: new Set() as Listeners<[CatalogListing]>,
    build: new Set() as Listeners<[BuildEvent]>,
    ptyData: new Set() as Listeners<[string, string]>,
    ptyExit: new Set() as Listeners<[string, number]>,
    snapshot: new Set() as Listeners<[StateSnapshot]>,
    serial: new Set() as Listeners<[string, number]>,
    log: new Set() as Listeners<[LogLine, number]>,
    status: new Set() as Listeners<[RunInfo]>,
    controlState: new Set() as Listeners<[ConnectionState]>,
    controlMessage: new Set() as Listeners<[Hello | Telemetry | Log]>,
    controlRaw: new Set() as Listeners<[string, 'in' | 'out']>,
  };

  const record = (service: ServiceName, method: string, args: unknown[]): void => {
    calls.push({ service, method, args });
  };
  const needProject = (): ProjectInfo => {
    if (!project) throw new Error(ipcErrorMessage('no-project', 'no project is open'));
    return project;
  };
  const read = (path: string): string => {
    const content = files.get(path);
    if (content === undefined)
      throw new Error(ipcErrorMessage('not-found', `${path} does not exist`));
    return content;
  };
  const write = (path: string, content: string): void => {
    const kind = files.has(path) ? 'change' : 'add';
    files.set(path, content);
    fire(ev.fileChange, { kind, path });
  };

  const listing = (): CatalogListing => {
    const custom: { path: string; definition: PartDefinition }[] = [];
    const problems: CatalogProblem[] = [];
    for (const [path, content] of files) {
      if (!path.startsWith('parts/') || !path.endsWith('.json')) continue;
      const parsed = PartDefinition.safeParse(JSON.parse(content));
      if (parsed.success) custom.push({ path, definition: parsed.data });
      else problems.push({ source: path, message: parsed.error.issues[0]?.message ?? 'invalid' });
    }
    return {
      builtIn: DEFAULT_CATALOG_ENTRIES.map((e) => PartDefinition.parse(e.data)),
      custom,
      problems,
    };
  };

  let run: RunInfo | null = null;
  const setRun = (next: RunInfo | null): void => {
    run = next;
    if (next) fire(ev.status, next);
  };
  const needRun = (): RunInfo => {
    if (!run) throw new Error(ipcErrorMessage('no-run', 'no run is active'));
    return run;
  };
  let liveWorld: WorldFile | null = null;
  let controlState: ConnectionState = 'idle';
  const setControl = (state: ConnectionState): void => {
    controlState = state;
    fire(ev.controlState, state);
  };

  const api: RcsimApi = {
    platform: options.platform ?? 'linux',
    project: {
      async open(target) {
        record('project', 'open', [target]);
        project = { dir: target ?? dir, name: 'Fake car' };
        return project;
      },
      async create(target) {
        record('project', 'create', [target]);
        for (const [path, content] of Object.entries(DEFAULT_FILES())) files.set(path, content);
        project = { dir: target, name: 'Default car' };
        return project;
      },
      async current() {
        return project;
      },
      async recent() {
        return project ? [project] : [];
      },
      async readCar() {
        record('project', 'readCar', []);
        needProject();
        const raw = read('car.json');
        try {
          const car = Car.safeParse(JSON.parse(raw));
          return car.success
            ? { ok: true, car: car.data }
            : { ok: false, raw, error: car.error.issues[0]?.message ?? 'invalid car.json' };
        } catch (error) {
          return { ok: false, raw, error: String(error) };
        }
      },
      async writeCar(car) {
        record('project', 'writeCar', [car]);
        needProject();
        const parsed = Car.parse(car);
        const catalog = createCatalog(
          listing().custom.map((c) => ({ source: c.path, data: c.definition })),
          defaultCatalog,
        );
        write('car.json', `${JSON.stringify(parsed, null, 2)}\n`);
        write('include/car_config.h', generateCarConfigHeader(parsed, catalog));
      },
      async listFiles() {
        const dirs = new Set<string>();
        for (const path of files.keys()) {
          const parts = path.split('/');
          for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
        }
        return [
          ...[...dirs].sort().map((path) => ({ path, kind: 'dir' as const })),
          ...[...files.keys()].sort().map((path) => ({ path, kind: 'file' as const })),
        ];
      },
      async readFile(path) {
        return read(path);
      },
      async writeFile(path, content) {
        record('project', 'writeFile', [path, content]);
        write(path, content);
      },
      onFileChange: (listener) => subscribe(ev.fileChange, listener),
    },
    catalog: {
      async list() {
        return listing();
      },
      async saveCustomPart(definition) {
        record('catalog', 'saveCustomPart', [definition]);
        const parsed = PartDefinition.safeParse(definition);
        if (!parsed.success) {
          throw new Error(
            ipcErrorMessage('invalid', parsed.error.issues[0]?.message ?? 'invalid part'),
          );
        }
        const path = `parts/${parsed.data.id}.json`;
        write(path, `${JSON.stringify(parsed.data, null, 2)}\n`);
        fire(ev.catalog, listing());
        return { path };
      },
      onChange: (listener) => subscribe(ev.catalog, listener),
    },
    build: {
      async start(target) {
        record('build', 'start', [target]);
        const buildId = `build-${nextId++}`;
        const diagnostics = buildDiagnostics;
        queueMicrotask(() => {
          const text = diagnostics
            .map((d) => `${d.file}:${d.line}:${d.column}: ${d.severity}: ${d.message}\n`)
            .join('');
          if (text) fire(ev.build, { kind: 'output', buildId, stream: 'stderr', text });
          const ok = !diagnostics.some((d) => d.severity === 'error');
          fire(ev.build, {
            kind: 'done',
            buildId,
            ok,
            exitCode: ok ? 0 : 1,
            durationMs: 1,
            diagnostics,
          });
        });
        return { buildId };
      },
      async cancel(buildId) {
        record('build', 'cancel', [buildId]);
      },
      onEvent: (listener) => subscribe(ev.build, listener),
    },
    pty: {
      async spawn(spawnOptions) {
        record('pty', 'spawn', [spawnOptions]);
        return { ptyId: `pty-${nextId++}` };
      },
      async write(ptyId, data) {
        record('pty', 'write', [ptyId, data]);
        fire(ev.ptyData, ptyId, data); // echo, like a terminal
      },
      async resize(ptyId, cols, rows) {
        record('pty', 'resize', [ptyId, cols, rows]);
      },
      async kill(ptyId) {
        record('pty', 'kill', [ptyId]);
        fire(ev.ptyExit, ptyId, 0);
      },
      onData: (listener) => subscribe(ev.ptyData, listener),
      onExit: (listener) => subscribe(ev.ptyExit, listener),
    },
    run: {
      async start(startOptions) {
        record('run', 'start', [startOptions]);
        if (run && run.state !== 'ended')
          throw new Error(ipcErrorMessage('busy', 'a run is active'));
        liveWorld =
          typeof startOptions.world === 'string'
            ? World.parse(JSON.parse(read(startOptions.world)))
            : World.parse(startOptions.world);
        setRun({
          runId: `run-${nextId++}`,
          state: startOptions.paused ? 'paused' : 'running',
          speed: startOptions.speed ?? 1,
          seed: startOptions.seed,
          end: null,
          netMappings: [
            { proto: 'tcp', firmwarePort: 3333, hostPort: 41333, bindAddress: '127.0.0.1' },
          ],
        });
        return needRun();
      },
      async stop() {
        record('run', 'stop', []);
        if (run) setRun({ ...run, state: 'ended', end: { kind: 'stopped' } });
      },
      async pause() {
        record('run', 'pause', []);
        setRun({ ...needRun(), state: 'paused' });
      },
      async resume() {
        record('run', 'resume', []);
        setRun({ ...needRun(), state: 'running' });
      },
      async step(ticks) {
        record('run', 'step', [ticks ?? 1]);
        needRun();
      },
      async setSpeed(speed: RunSpeed) {
        record('run', 'setSpeed', [speed]);
        setRun({ ...needRun(), speed });
      },
      async info() {
        return run;
      },
      async sendSerial(text) {
        record('run', 'sendSerial', [text]);
        needRun();
      },
      onSnapshot: (listener) => subscribe(ev.snapshot, listener),
      onSerial: (listener) => subscribe(ev.serial, listener),
      onLog: (listener) => subscribe(ev.log, listener),
      onStatus: (listener) => subscribe(ev.status, listener),
    },
    worldEdit: {
      async listLayouts() {
        return [...files.keys()]
          .filter((p) => p.startsWith('worlds/') && p.endsWith('.json'))
          .sort();
      },
      async load(path) {
        record('worldEdit', 'load', [path]);
        return World.parse(JSON.parse(read(path)));
      },
      async save(path, world) {
        record('worldEdit', 'save', [path, world]);
        write(path, `${JSON.stringify(World.parse(world), null, 2)}\n`);
      },
      async addObstacle(obstacle) {
        record('worldEdit', 'addObstacle', [obstacle]);
        if (!liveWorld) throw new Error(ipcErrorMessage('no-run', 'no run is active'));
        const id = obstacle.id ?? `obstacle-${nextId++}`;
        liveWorld = { ...liveWorld, obstacles: [...liveWorld.obstacles, { ...obstacle, id }] };
        return id;
      },
      async moveObstacle(id, position, yawDeg) {
        record('worldEdit', 'moveObstacle', [id, position, yawDeg]);
        if (!liveWorld) throw new Error(ipcErrorMessage('no-run', 'no run is active'));
        if (!liveWorld.obstacles.some((o) => o.id === id)) {
          throw new Error(ipcErrorMessage('not-found', `no obstacle ${id}`));
        }
        liveWorld = {
          ...liveWorld,
          obstacles: liveWorld.obstacles.map((o) =>
            o.id === id ? { ...o, positionM: { ...position }, yawDeg } : o,
          ),
        };
      },
      async removeObstacle(id) {
        record('worldEdit', 'removeObstacle', [id]);
        if (!liveWorld) throw new Error(ipcErrorMessage('no-run', 'no run is active'));
        liveWorld = { ...liveWorld, obstacles: liveWorld.obstacles.filter((o) => o.id !== id) };
      },
      async currentLayout() {
        if (!liveWorld) throw new Error(ipcErrorMessage('no-run', 'no run is active'));
        return liveWorld;
      },
    },
    control: {
      async connect(target) {
        record('control', 'connect', [target]);
        setControl('connected');
      },
      async disconnect() {
        record('control', 'disconnect', []);
        setControl('closed');
      },
      async drive(command) {
        record('control', 'drive', [command]);
        return controlState === 'connected';
      },
      async releaseDrive() {
        record('control', 'releaseDrive', []);
      },
      async setMode(mode) {
        record('control', 'setMode', [mode]);
        return controlState === 'connected';
      },
      async estop() {
        record('control', 'estop', []);
        return controlState === 'connected';
      },
      async sendRaw(line) {
        record('control', 'sendRaw', [line]);
        if (controlState !== 'connected') return false;
        fire(ev.controlRaw, line, 'out');
        return true;
      },
      onState: (listener) => subscribe(ev.controlState, listener),
      onMessage: (listener) => subscribe(ev.controlMessage, listener),
      onRaw: (listener) => subscribe(ev.controlRaw, listener),
    },
  };

  return {
    api,
    calls,
    files,
    emit: {
      fileChange: (change) => fire(ev.fileChange, change),
      snapshot: (snapshot) => fire(ev.snapshot, snapshot),
      serial: (text, tUs = 0) => fire(ev.serial, text, tUs),
      controlState: (state) => setControl(state),
      controlMessage: (message) => {
        fire(ev.controlMessage, message);
        fire(ev.controlRaw, JSON.stringify(message), 'in');
      },
      ptyData: (ptyId, data) => fire(ev.ptyData, ptyId, data),
    },
    setBuildDiagnostics(diagnostics) {
      buildDiagnostics = diagnostics;
    },
  };
}
