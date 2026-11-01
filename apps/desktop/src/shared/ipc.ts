// The typed API between the renderer and the main process (P0-05). The
// preload exposes exactly `RcsimApi` as `window.rcsim`; main implements it.
// Types only, plus the channel tables both sides wire from. This file is
// imported by the renderer, so it must stay free of Node and Electron imports.

import type {
  Car,
  CatalogProblem,
  Obstacle,
  PartDefinition,
  Track,
  World as WorldFile,
} from '@rcsim/schema';
import type {
  ConnectionState,
  Hello,
  Log,
  Mode,
  Telemetry,
} from '@rcsim/control-protocol/messages';
import type { RunEnd, StateSnapshot } from '@rcsim/sim-core/api';
import type { LogLine, NetProto } from '@rcsim/sim-protocol';

export type Unsubscribe = () => void;

// ── project ────────────────────────────────────────────────────────────────

export interface ProjectInfo {
  /** Absolute path of the car project folder. */
  readonly dir: string;
  /** `car.json` name, or the folder name if car.json can't be read. */
  readonly name: string;
}

/** Paths in the project API are project-relative with `/` separators; main rejects any that escape the folder. */
export interface FileEntry {
  readonly path: string;
  readonly kind: 'file' | 'dir';
}

export interface FileChange {
  readonly kind: 'add' | 'change' | 'remove';
  readonly path: string;
}

export type CarReadResult =
  | { readonly ok: true; readonly car: Car }
  | { readonly ok: false; readonly raw: string; readonly error: string };

export interface ProjectApi {
  /** Opens a car project; without `dir`, shows a folder picker. Null if cancelled. */
  open(dir?: string): Promise<ProjectInfo | null>;
  /** Creates a project in `dir` from packages/firmware-template, then opens it. */
  create(dir: string): Promise<ProjectInfo>;
  current(): Promise<ProjectInfo | null>;
  recent(): Promise<readonly ProjectInfo[]>;
  readCar(): Promise<CarReadResult>;
  /** Writes car.json and regenerates include/car_config.h with generateCarConfigHeader. */
  writeCar(car: Car): Promise<void>;
  listFiles(): Promise<readonly FileEntry[]>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  /** Changes on disk, from any source (the editor, the shell, git). */
  onFileChange(listener: (change: FileChange) => void): Unsubscribe;
}

// ── catalog ────────────────────────────────────────────────────────────────

export interface CatalogListing {
  readonly builtIn: readonly PartDefinition[];
  /** The project's `parts/*.json` that parsed. */
  readonly custom: readonly { readonly path: string; readonly definition: PartDefinition }[];
  /** Custom part files that didn't (source = their path). */
  readonly problems: readonly CatalogProblem[];
}

export interface CatalogApi {
  list(): Promise<CatalogListing>;
  /** Validates with PartDefinition and writes `parts/<id>.json`; rejects with code `invalid` on a bad part. */
  saveCustomPart(definition: PartDefinition): Promise<{ readonly path: string }>;
  onChange(listener: (listing: CatalogListing) => void): Unsubscribe;
}

// ── build ──────────────────────────────────────────────────────────────────

/** A compiler diagnostic parsed from GCC or Clang output. `file` is project-relative when inside the project. */
export interface Diagnostic {
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly severity: 'error' | 'warning' | 'note';
  readonly message: string;
}

export type BuildTarget = 'sim' | 'esp32';

export type BuildEvent =
  | {
      readonly kind: 'output';
      readonly buildId: string;
      readonly stream: 'stdout' | 'stderr';
      /** Output as produced, unchanged. */
      readonly text: string;
    }
  | {
      readonly kind: 'done';
      readonly buildId: string;
      readonly ok: boolean;
      readonly exitCode: number | null;
      readonly durationMs: number;
      readonly diagnostics: readonly Diagnostic[];
    };

export interface BuildApi {
  /** `sim`: hal's build-sim. `esp32`: `pio run -e esp32dev` (offers to install PlatformIO if missing). */
  start(target: BuildTarget): Promise<{ readonly buildId: string }>;
  cancel(buildId: string): Promise<void>;
  onEvent(listener: (event: BuildEvent) => void): Unsubscribe;
}

// ── pty ────────────────────────────────────────────────────────────────────

export interface PtyApi {
  /** Starts the user's $SHELL as a login shell; `cwd` defaults to the project folder. */
  spawn(options: { readonly cwd?: string; readonly cols: number; readonly rows: number }): Promise<{
    readonly ptyId: string;
  }>;
  write(ptyId: string, data: string): Promise<void>;
  resize(ptyId: string, cols: number, rows: number): Promise<void>;
  kill(ptyId: string): Promise<void>;
  onData(listener: (ptyId: string, data: string) => void): Unsubscribe;
  onExit(listener: (ptyId: string, exitCode: number) => void): Unsubscribe;
}

// ── run ────────────────────────────────────────────────────────────────────

export const RUN_SPEEDS = [0.25, 0.5, 1, 2, 4, 8, 'unpaced'] as const;
export type RunSpeed = (typeof RUN_SPEEDS)[number];

/** Where a firmware server is reachable on the host (from a sim-protocol LISTEN event). */
export interface NetMapping {
  readonly proto: NetProto;
  readonly firmwarePort: number;
  readonly hostPort: number;
  readonly bindAddress: string;
}

export interface RunStartOptions {
  /** A project-relative `worlds/*.json` path, or a world held by the renderer. */
  readonly world: string | WorldFile;
  readonly seed: number;
  /** Default 1. */
  readonly speed?: RunSpeed;
  /** Start paused at tick 0. Default false. */
  readonly paused?: boolean;
}

export interface RunInfo {
  readonly runId: string;
  /** `starting` while checking wiring, building and launching the firmware. */
  readonly state: 'starting' | 'running' | 'paused' | 'ended';
  /** The world's track, for `worldEdit.loadTrack`. */
  readonly trackId: string;
  readonly speed: RunSpeed;
  readonly seed: number;
  /** Set once the run has ended. */
  readonly end: RunEnd | null;
  readonly netMappings: readonly NetMapping[];
}

export interface RunApi {
  /**
   * Run in Sim, the whole action: checks the wiring (rejects with
   * `wiring-errors`), builds the sim firmware if any source or car.json
   * changed since the last successful build (progress on `build.onEvent`;
   * rejects with `build-failed`), then starts the run. Rejects with `busy` if
   * a run is active. `onStatus` reports `starting` meanwhile.
   */
  start(options: RunStartOptions): Promise<RunInfo>;
  stop(): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  /** While paused: advances `ticks` ticks (default 1). Rejects with `busy` while running. */
  step(ticks?: number): Promise<void>;
  /** Reboots the firmware while the world carries on, like pressing EN on the ESP32. */
  restartFirmware(): Promise<void>;
  setSpeed(speed: RunSpeed): Promise<void>;
  info(): Promise<RunInfo | null>;
  /** Text to the firmware's Serial RX (the Serial Monitor's send line). */
  sendSerial(text: string): Promise<void>;
  /** About 60 Hz while running, and once after each pause, step or edit. */
  onSnapshot(listener: (snapshot: StateSnapshot) => void): Unsubscribe;
  /** Firmware Serial output, decoded as UTF-8, with the sim time it was written. */
  onSerial(listener: (text: string, tUs: number) => void): Unsubscribe;
  /** hal diagnostics. */
  onLog(listener: (line: LogLine, tUs: number) => void): Unsubscribe;
  /** Every state change: start, pause, resume, speed, new net mappings, end. */
  onStatus(listener: (info: RunInfo) => void): Unsubscribe;
}

// ── world-edit ─────────────────────────────────────────────────────────────

/**
 * Obstacle editing. Without a run, the renderer edits its own WorldFile and
 * saves it with `save`. With a run that is paused, add/move/remove change the
 * live world (and a snapshot follows); while running they reject with `busy`.
 */
export interface WorldEditApi {
  /** Ids of the built-in tracks (`oval`, `technical`). */
  listTracks(): Promise<readonly string[]>;
  /** A built-in track, for drawing the track mesh. Rejects with `not-found`. */
  loadTrack(id: string): Promise<Track>;
  /** Project-relative paths of `worlds/*.json`. */
  listLayouts(): Promise<readonly string[]>;
  load(path: string): Promise<WorldFile>;
  /** Validates with the World schema and writes the file. */
  save(path: string, world: WorldFile): Promise<void>;
  addObstacle(obstacle: Obstacle): Promise<string>;
  moveObstacle(
    id: string,
    position: { readonly x: number; readonly z: number },
    yawDeg: number,
  ): Promise<void>;
  removeObstacle(id: string): Promise<void>;
  /** The live run's layout, for saving it. Rejects with `no-run` without a run. */
  currentLayout(): Promise<WorldFile>;
}

// ── control ────────────────────────────────────────────────────────────────

export type ControlTarget =
  | { readonly kind: 'host'; readonly host: string; readonly port: number }
  /** The running sim car, at its mapped control port (3333 → host port). */
  | { readonly kind: 'run' };

/**
 * The main process's ControlClient (control-protocol), shared by manual
 * driving and the Network Console (ADR 0004). Keyboard and gamepad input are
 * read in the renderer and sent with `drive`.
 */
export interface ControlApi {
  connect(target: ControlTarget): Promise<void>;
  disconnect(): Promise<void>;
  /** Holds a drive command (resent every 100 ms by the client); false when not connected. */
  drive(command: { readonly throttle: number; readonly steer: number }): Promise<boolean>;
  releaseDrive(): Promise<void>;
  setMode(mode: Mode): Promise<boolean>;
  estop(): Promise<boolean>;
  /** A raw line from the Network Console, sent as typed. */
  sendRaw(line: string): Promise<boolean>;
  onState(listener: (state: ConnectionState) => void): Unsubscribe;
  onMessage(listener: (message: Hello | Telemetry | Log) => void): Unsubscribe;
  /** Every line both ways, for the Network Console. */
  onRaw(listener: (line: string, direction: 'in' | 'out') => void): Unsubscribe;
}

// ── the whole API ──────────────────────────────────────────────────────────

export interface RcsimApi {
  readonly platform: 'linux' | 'darwin';
  readonly project: ProjectApi;
  readonly catalog: CatalogApi;
  readonly build: BuildApi;
  readonly pty: PtyApi;
  readonly run: RunApi;
  readonly worldEdit: WorldEditApi;
  readonly control: ControlApi;
}

export type ServiceName = Exclude<keyof RcsimApi, 'platform'>;

type Listener = (...args: never[]) => void;
type EventKeys<T> = { [K in keyof T]: K extends `on${string}` ? K : never }[keyof T];
type MethodKeys<T> = Exclude<keyof T, EventKeys<T>>;

/**
 * Request/response methods per service. Channel: `<service>:<method>`
 * (ipcRenderer.invoke / ipcMain.handle). Arguments and results are
 * structured-clone data.
 */
export const IPC_METHODS = {
  project: [
    'open',
    'create',
    'current',
    'recent',
    'readCar',
    'writeCar',
    'listFiles',
    'readFile',
    'writeFile',
  ],
  catalog: ['list', 'saveCustomPart'],
  build: ['start', 'cancel'],
  pty: ['spawn', 'write', 'resize', 'kill'],
  run: [
    'start',
    'stop',
    'pause',
    'resume',
    'step',
    'restartFirmware',
    'setSpeed',
    'info',
    'sendSerial',
  ],
  worldEdit: [
    'listTracks',
    'loadTrack',
    'listLayouts',
    'load',
    'save',
    'addObstacle',
    'moveObstacle',
    'removeObstacle',
    'currentLayout',
  ],
  control: ['connect', 'disconnect', 'drive', 'releaseDrive', 'setMode', 'estop', 'sendRaw'],
} as const satisfies { readonly [S in ServiceName]: readonly MethodKeys<RcsimApi[S]>[] };

/**
 * Event subscriptions per service. Channel: `<service>:<event>` (main
 * webContents.send → preload ipcRenderer.on); the listener gets the
 * channel's arguments in order.
 */
export const IPC_EVENTS = {
  project: ['onFileChange'],
  catalog: ['onChange'],
  build: ['onEvent'],
  pty: ['onData', 'onExit'],
  run: ['onSnapshot', 'onSerial', 'onLog', 'onStatus'],
  worldEdit: [],
  control: ['onState', 'onMessage', 'onRaw'],
} as const satisfies { readonly [S in ServiceName]: readonly EventKeys<RcsimApi[S]>[] };

export const ipcChannel = (service: ServiceName, member: string): string => `${service}:${member}`;

/** Arguments a main-side event emitter sends for one event, e.g. `EventArgs<'run', 'onSerial'>` = `[string, number]`. */
export type EventArgs<
  S extends ServiceName,
  E extends EventKeys<RcsimApi[S]>,
> = RcsimApi[S][E] extends (listener: infer L) => Unsubscribe
  ? L extends Listener
    ? Parameters<L>
    : never
  : never;

// ── errors ─────────────────────────────────────────────────────────────────

export type IpcErrorCode =
  | 'no-project'
  | 'not-found'
  | 'invalid'
  | 'wiring-errors'
  | 'no-build'
  | 'build-failed'
  | 'no-run'
  | 'busy'
  | 'io'
  | 'not-implemented';

/**
 * Electron passes only an error's message through `invoke`, so main throws
 * `new Error(ipcErrorMessage(code, text))` and the renderer reads it back
 * with `parseIpcError`.
 */
export function ipcErrorMessage(code: IpcErrorCode, text: string): string {
  return `[rcsim:${code}] ${text}`;
}

export function parseIpcError(error: unknown): { code: IpcErrorCode | 'unknown'; message: string } {
  const raw = error instanceof Error ? error.message : String(error);
  const match = /\[rcsim:([a-z-]+)\] ([\s\S]*)$/.exec(raw);
  return match
    ? { code: match[1] as IpcErrorCode, message: match[2] ?? '' }
    : { code: 'unknown', message: raw };
}

declare global {
  interface Window {
    /** Exposed by the preload; see RcsimApi. */
    readonly rcsim: RcsimApi;
  }
}
