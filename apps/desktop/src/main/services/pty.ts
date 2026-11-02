import { randomUUID } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { spawn, type IPty } from 'node-pty';
import type { PtyApi } from '../../shared/ipc.ts';
import { errorText, fail } from './errors.ts';
import { Signal } from './events.ts';
import { ensurePtyHelperExecutable, ptyHelperPath, selectShell } from './pty-support.ts';
import type { ProjectService } from './project.ts';

export class PtyService implements PtyApi {
  private generation = 0;
  private readonly terminals = new Map<string, IPty>();
  private readonly data = new Signal<[string, string]>();
  private readonly exit = new Signal<[string, number]>();
  readonly onData = this.data.subscribe;
  readonly onExit = this.exit.subscribe;
  private readonly project: ProjectService;
  constructor(project: ProjectService) {
    this.project = project;
  }

  private size(cols: number, rows: number): void {
    if (![cols, rows].every((n) => Number.isInteger(n) && n > 0 && n <= 1000))
      fail('invalid', 'Terminal size must be between 1 and 1000.');
  }
  async spawn(options: {
    readonly cwd?: string;
    readonly cols: number;
    readonly rows: number;
  }): Promise<{ readonly ptyId: string }> {
    this.size(options.cols, options.rows);
    const generation = this.generation;
    let cwd = options.cwd ?? this.project.requireProject().dir;
    let shell = process.platform === 'darwin' ? '/bin/zsh' : '/bin/sh';
    let helper = '(not resolved)';
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] =>
          entry[1] !== undefined &&
          !['ELECTRON_RUN_AS_NODE', 'ELECTRON_NO_ASAR', 'NODE_OPTIONS'].includes(entry[0]),
      ),
    );
    let terminal: IPty;
    try {
      shell = await selectShell();
      helper = ptyHelperPath();
      cwd = await realpath(cwd);
      if (!(await stat(cwd)).isDirectory()) throw new Error('Shell directory does not exist.');
      if (process.platform === 'darwin') await ensurePtyHelperExecutable(helper);
      // A navigation may dispose the renderer while path/helper checks await IO.
      if (generation !== this.generation)
        fail('busy', 'Shell creation was cancelled by renderer navigation.');
      terminal = spawn(shell, ['-l'], {
        name: 'xterm-256color',
        cols: options.cols,
        rows: options.rows,
        cwd,
        env,
      });
    } catch (error) {
      fail(
        generation !== this.generation ? 'busy' : 'io',
        `Could not start shell (shell=${shell}, cwd=${cwd}, helper=${helper}): ${errorText(error)}`,
      );
    }
    const ptyId = randomUUID();
    this.terminals.set(ptyId, terminal);
    terminal.onData((text) => this.data.emit(ptyId, text));
    terminal.onExit(({ exitCode }) => {
      this.terminals.delete(ptyId);
      this.exit.emit(ptyId, exitCode);
    });
    return { ptyId };
  }
  private get(id: string): IPty {
    return this.terminals.get(id) ?? fail('not-found', 'Shell panel has exited.');
  }
  async write(id: string, data: string): Promise<void> {
    if (typeof data !== 'string') fail('invalid', 'Terminal input must be text.');
    this.get(id).write(data);
  }
  async resize(id: string, cols: number, rows: number): Promise<void> {
    this.size(cols, rows);
    this.get(id).resize(cols, rows);
  }
  async kill(id: string): Promise<void> {
    this.terminals.get(id)?.kill();
  }
  dispose(): void {
    this.generation++;
    for (const terminal of this.terminals.values()) terminal.kill();
    this.terminals.clear();
  }
}
