import { stripVTControlCharacters } from 'node:util';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { isAbsolute, relative, sep } from 'node:path';
import type { BuildApi, BuildEvent, BuildTarget, Diagnostic } from '../../shared/ipc.ts';
import { errorText, fail } from './errors.ts';
import { Signal } from './events.ts';
import type { ProjectService } from './project.ts';

/** GCC and Clang share file:line:column; strip only ANSI for parsing, never for output. */
export function parseDiagnostics(output: string, projectDir: string): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const plain = stripVTControlCharacters(output);
  for (const line of plain.split(/\r?\n/)) {
    const match = /^(.*?):(\d+):(?:(\d+):)?\s*(fatal error|error|warning|note):\s*(.*)$/.exec(line);
    if (!match) continue;
    const file = match[1] ?? '';
    const rel = isAbsolute(file) ? relative(projectDir, file) : file.replace(/^\.\//, '');
    diagnostics.push({
      file:
        isAbsolute(file) && (rel === '..' || rel.startsWith(`..${sep}`))
          ? file
          : rel.split(sep).join('/'),
      line: Number(match[2]),
      column: Number(match[3] ?? 1),
      severity: match[4] === 'fatal error' ? 'error' : (match[4] as Diagnostic['severity']),
      message: match[5] ?? '',
    });
  }
  return diagnostics;
}

export class BuildService implements BuildApi {
  private active:
    { id: string; child: ChildProcess; cancelTimer?: ReturnType<typeof setTimeout> } | undefined;
  private readonly events = new Signal<[BuildEvent]>();
  readonly onEvent = this.events.subscribe;
  private readonly project: ProjectService;
  private readonly driver: string;
  constructor(project: ProjectService, driver: string) {
    this.project = project;
    this.driver = driver;
  }

  async start(target: BuildTarget): Promise<{ readonly buildId: string }> {
    if (target !== 'sim' && target !== 'esp32') fail('invalid', 'Unknown build target.');
    if (target === 'esp32') fail('not-implemented', 'PlatformIO builds are scheduled for Phase 3.');
    if (this.active) fail('busy', 'A build is already running.');
    const dir = this.project.requireProject().dir;
    const buildId = randomUUID();
    const started = performance.now();
    // No shell interpolation: project paths can contain spaces and shell metacharacters.
    const child = spawn(this.driver, [dir], { cwd: dir, env: process.env, detached: true });
    this.active = { id: buildId, child };
    const output: Record<'stdout' | 'stderr', string> = { stdout: '', stderr: '' };
    let finished = false;
    let cancelled = false;
    const done = (exitCode: number | null): void => {
      if (finished) return;
      finished = true;
      clearTimeout(this.active?.cancelTimer);
      this.active = undefined;
      this.events.emit({
        kind: 'done',
        buildId,
        ok: exitCode === 0 && !cancelled,
        exitCode,
        durationMs: performance.now() - started,
        diagnostics: [
          ...parseDiagnostics(output.stdout, dir),
          ...parseDiagnostics(output.stderr, dir),
        ],
      });
    };
    for (const stream of ['stdout', 'stderr'] as const) {
      child[stream]?.setEncoding('utf8').on('data', (text: string) => {
        output[stream] += text;
        this.events.emit({ kind: 'output', buildId, stream, text });
      });
    }
    child.once('error', (error) => {
      this.events.emit({
        kind: 'output',
        buildId,
        stream: 'stderr',
        text: `Could not start HAL build-sim: ${errorText(error)}\n`,
      });
      done(null);
    });
    child.once('close', (code, signal) => {
      cancelled = signal !== null;
      done(code);
    });
    return { buildId };
  }
  async cancel(buildId: string): Promise<void> {
    if (this.active?.id !== buildId) return;
    const { child } = this.active;
    this.signal(child, 'SIGTERM');
    this.active.cancelTimer = setTimeout(() => this.signal(child, 'SIGKILL'), 1000);
  }
  private signal(child: ChildProcess, signal: NodeJS.Signals): void {
    if (!child.pid) return;
    try {
      process.kill(-child.pid, signal);
    } catch {
      /* The build may already have exited. */
    }
  }
  dispose(): void {
    if (this.active) {
      clearTimeout(this.active.cancelTimer);
      this.signal(this.active.child, 'SIGKILL');
    }
  }
}
