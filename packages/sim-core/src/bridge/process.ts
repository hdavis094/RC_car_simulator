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
const alive = new Set<ChildProcess>();
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
  for (const child of alive) child.kill('SIGKILL');
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

/**
 * One firmware process. Its stdout is drained and dropped (Serial goes over
 * sim-protocol), its stderr is kept as a tail of lines for crash reports.
 */
export class FirmwareProcess {
  readonly #child: ChildProcess;
  readonly #tail: string[] = [];
  #partial = '';
  #exited = false;
  readonly exit: Promise<ExitInfo>;

  /** Rejects (as `exit` does) when the process can't be started at all. */
  constructor(binary: string, cwd: string, env: NodeJS.ProcessEnv) {
    this.#child = spawn(binary, [], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    alive.add(this.#child);
    hookExit();
    this.#child.stdout?.resume();
    this.#child.stderr?.setEncoding('utf8');
    this.#child.stderr?.on('data', (text: string) => this.#onStderr(text));
    this.exit = new Promise<ExitInfo>((resolve, reject) => {
      // 'close' comes after the exit and after stdio is drained, so the tail is complete.
      this.#child.once('close', (exitCode, signal) => {
        this.#exited = true;
        alive.delete(this.#child);
        if (this.#partial) this.#keep(this.#partial);
        this.#partial = '';
        resolve({ exitCode, signal, stderrTail: [...this.#tail] });
      });
      this.#child.once('error', (error) => {
        this.#exited = true;
        alive.delete(this.#child);
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

  kill(signal: NodeJS.Signals = 'SIGKILL'): void {
    if (!this.#exited) this.#child.kill(signal);
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
