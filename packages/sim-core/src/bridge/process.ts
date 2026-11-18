import { spawn, type ChildProcess } from 'node:child_process';

/** How a firmware process ended. */
export interface ExitInfo {
  readonly exitCode: number | null;
  readonly signal: string | null;
  /** The last lines the process wrote to stderr. */
  readonly stderrTail: readonly string[];
}

const TAIL_LINES = 20;

/**
 * Processes still running. A firmware that spins without calling hal never
 * notices its socket closing, so if this process exits first they would be
 * orphaned and spin forever: the exit hook kills them.
 */
const alive = new Set<ChildProcess>();
let hooked = false;
function hookExit(): void {
  if (hooked) return;
  hooked = true;
  process.once('exit', () => {
    for (const child of alive) child.kill('SIGKILL');
  });
}
const TAIL_LINE_CHARS = 500;

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
