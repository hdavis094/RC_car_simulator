import { spawn, type ChildProcess } from 'node:child_process';
import { rmSync } from 'node:fs';

/** How a firmware process ended. */
export interface ExitInfo {
  readonly exitCode: number | null;
  readonly signal: string | null;
  /** The last lines the process wrote to stderr. */
  readonly stderrTail: readonly string[];
}

const TAIL_LINES = 20;
const TAIL_LINE_CHARS = 500;

/**
 * Processes still running. A firmware that spins without calling hal never
 * notices its socket closing, so whoever hosts the bridge must kill these when
 * it goes: the host's quit handler calls `killAllFirmware()`; the CLI also
 * installs signal handlers (`installTerminationHandlers`). The `exit` hook
 * below covers a host that simply returns or calls `process.exit()`; it
 * changes no exit behaviour, so a library may have it.
 */
const alive = new Set<FirmwareProcess>();
let hooked = false;
function hookExit(): void {
  if (hooked) return;
  hooked = true;
  process.once('exit', killAllFirmware);
}

/** Socket files of live sources, removed by `killAllFirmware` along with the processes. */
const sockets = new Set<string>();
export const trackSocket = (file: string): void => void sockets.add(file);
export const untrackSocket = (file: string): void => void sockets.delete(file);

/**
 * Kills every firmware process still running, at once (SIGKILL), and removes
 * the sockets they were connected to. Synchronous: safe in an exit or signal handler.
 */
export function killAllFirmware(): void {
  for (const proc of alive) proc.kill('SIGKILL');
  for (const file of sockets) rmSync(file, { force: true });
}

/**
 * Makes SIGTERM, SIGINT and SIGHUP kill the firmware before the host dies of
 * them, and then lets the signal take its default course. Only an entry point
 * that owns the process (the `rcsim` CLI) should call this: a library that
 * installed signal handlers would change its host's exit behaviour. The desktop
 * app calls `killAllFirmware()` from its own quit handling instead.
 */
export function installTerminationHandlers(): void {
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
    process.once(signal, () => {
      killAllFirmware();
      // `once` has removed this handler, so the signal now has its default effect.
      process.kill(process.pid, signal);
    });
  }
}

/** How long, after the process has exited, its stderr gets to deliver the last lines. */
const DRAIN_MS = 500;

/**
 * Sends `signal` to the firmware's whole process group (it is spawned as the
 * leader of its own), so helpers it started die with it. POSIX; fine on macOS.
 */
function killGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, signal);
  } catch {
    // no such group: nothing is left of it
  }
}

/**
 * One firmware process, the leader of its own process group. Its stdout is
 * drained and dropped (Serial goes over sim-protocol), its stderr is kept as a
 * tail of lines for crash reports.
 *
 * `exit` settles when the process has *exited*, not when every holder of its
 * pipes has let go: a helper that inherited stdout/stderr would otherwise keep
 * a dead firmware "running" for as long as it lives. On exit the rest of the
 * group is killed, and the pipes get at most `DRAIN_MS` to deliver the last
 * stderr lines before they are destroyed.
 */
export class FirmwareProcess {
  readonly #child: ChildProcess;
  readonly #tail: string[] = [];
  #partial = '';
  #exited = false;
  readonly exit: Promise<ExitInfo>;

  /** Rejects (as `exit` does) when the process can't be started at all. */
  constructor(binary: string, cwd: string, env: NodeJS.ProcessEnv) {
    this.#child = spawn(binary, [], {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true, // its own process group (setsid): `killGroup` reaches its helpers
    });
    alive.add(this);
    hookExit();
    const child = this.#child;
    child.stdout?.resume();
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (text: string) => this.#onStderr(text));
    const stderrClosed = new Promise<void>((resolve) => {
      if (!child.stderr) resolve();
      else child.stderr.once('close', () => resolve());
    });
    this.exit = new Promise<ExitInfo>((resolve, reject) => {
      child.once('exit', (exitCode, signal) => {
        this.#exited = true;
        alive.delete(this);
        // Whatever the firmware left running in its group goes with it, and that
        // releases the pipes it inherited. The stall and stop paths have already signalled
        // the group while the leader was alive; this matters for helpers left behind by a
        // firmware that exits by itself. The leader is reaped by now, which is a known,
        // accepted limitation: POSIX never hands out a PID that is still in use as a process
        // group id while any member exists, so when helpers remain `kill(-pid)` reaches
        // exactly them, and when none remain the call does nothing. A wrong kill would take
        // PID wraparound inside this window *and* the new process starting a group of its own.
        // Node can't keep an exited child unreaped, so closing that last window would need a
        // native helper, which is out of proportion to the risk.
        killGroup(child.pid, 'SIGKILL');
        const timer = Promise.withResolvers<void>();
        const handle = setTimeout(() => timer.resolve(), DRAIN_MS);
        void Promise.race([stderrClosed, timer.promise]).then(() => {
          clearTimeout(handle);
          child.stdout?.destroy();
          child.stderr?.destroy();
          if (this.#partial) this.#keep(this.#partial);
          this.#partial = '';
          resolve({ exitCode, signal, stderrTail: [...this.#tail] });
        });
      });
      child.once('error', (error) => {
        this.#exited = true;
        alive.delete(this);
        reject(error);
      });
    });
    // A start failure is reported through whoever awaits `exit`; never leave it unhandled.
    this.exit.catch(() => undefined);
  }

  get pid(): number | undefined {
    return this.#child.pid;
  }

  get exited(): boolean {
    return this.#exited;
  }

  /** Signals the firmware and everything it started (its process group). */
  kill(signal: NodeJS.Signals = 'SIGKILL'): void {
    if (!this.#exited) killGroup(this.#child.pid, signal);
  }

  #onStderr(text: string): void {
    const lines = (this.#partial + text).split('\n');
    this.#partial = lines.pop() ?? '';
    // A line that never ends is kept in pieces rather than buffered without bound.
    if (this.#partial.length > 4 * TAIL_LINE_CHARS) {
      lines.push(this.#partial);
      this.#partial = '';
    }
    for (const line of lines) this.#keep(line);
  }

  #keep(line: string): void {
    const trimmed = line.replace(/\r$/, '');
    if (trimmed === '') return;
    this.#tail.push(
      trimmed.length > TAIL_LINE_CHARS ? `${trimmed.slice(0, TAIL_LINE_CHARS)}…` : trimmed,
    );
    if (this.#tail.length > TAIL_LINES) this.#tail.shift();
  }
}
