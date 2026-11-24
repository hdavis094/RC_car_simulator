import { stripVTControlCharacters } from 'node:util';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { relative, resolve, sep } from 'node:path';
import type { BuildApi, BuildEvent, BuildTarget, Diagnostic } from '../../shared/ipc.ts';
import { errorText, fail } from './errors.ts';
import { Signal } from './events.ts';
import type { PlatformioService } from './hardware/platformio.ts';
import type { ProjectService } from './project.ts';

/** GCC and Clang share file:line:column; strip only ANSI for parsing, never for output. */
export function parseDiagnostics(output: string, projectDir: string): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const filePath = (file: string): string => {
    const absolute = resolve(projectDir, file);
    const rel = relative(projectDir, absolute);
    return rel === '..' || rel.startsWith(`..${sep}`) ? absolute : rel.split(sep).join('/');
  };
  for (const line of stripVTControlCharacters(output).split(/\r?\n/)) {
    const match = /^(.*?):(\d+):(?:(\d+):)?\s*(fatal error|error|warning|note):\s*(.*)$/.exec(line);
    if (match) {
      diagnostics.push({
        file: filePath(match[1] ?? ''),
        line: Number(match[2]),
        column: Number(match[3] ?? 1),
        severity: match[4] === 'fatal error' ? 'error' : (match[4] as Diagnostic['severity']),
        message: match[5] ?? '',
      });
      continue;
    }
    // GNU ld may attach a source/object path and a section offset rather than
    // a source line. Use line 1 when that is all the linker provides.
    const located =
      /(?:^|:\s*)([^:]+):(?:(\d+):|\([^)]*\):)\s*((?:undefined reference|multiple definition|undefined symbol).*)$/.exec(
        line,
      );
    if (located) {
      diagnostics.push({
        file: filePath(located[1]?.trim() ?? ''),
        line: Number(located[2] ?? 1),
        column: 1,
        severity: 'error',
        message: (located[3] ?? '').trimEnd(),
      });
      continue;
    }
    // Apple ld, lld and compiler-driver summaries need no invented file path.
    const summary =
      /^(?:.*\/)?(?:ld(?:\.lld)?|collect2|clang\+\+|clang|g\+\+|gcc|c\+\+):\s*(?:error:\s*)?(.*(?:undefined|not found|multiple definition|duplicate symbol|linker command failed|ld returned).*)$/i.exec(
        line,
      );
    if (summary)
      diagnostics.push({
        file: '',
        line: 1,
        column: 1,
        severity: 'error',
        message: summary[1] ?? '',
      });
  }
  return diagnostics;
}

interface ActiveBuild {
  readonly id: string;
  readonly dir: string;
  child?: ChildProcess;
  cancelTimer?: ReturnType<typeof setTimeout>;
  cancelled: boolean;
}

interface UploadPreparation {
  validatePort(): Promise<void>;
  releaseSerial(): Promise<void>;
  releaseUpload(): void;
}

export class BuildService implements BuildApi {
  private active: ActiveBuild | undefined;
  private readonly events = new Signal<[BuildEvent]>();
  readonly onEvent = this.events.subscribe;
  private readonly project: ProjectService;
  private readonly simDriver: string;
  private readonly simRuntime:
    { readonly executable: string; readonly cacheDir: string } | undefined;
  private readonly platformio: Pick<PlatformioService, 'requirePath'> | undefined;

  constructor(
    project: ProjectService,
    simDriver: string,
    platformio?: Pick<PlatformioService, 'requirePath'>,
    simRuntime?: { readonly executable: string; readonly cacheDir: string },
  ) {
    this.project = project;
    this.simDriver = simDriver;
    this.platformio = platformio;
    this.simRuntime = simRuntime;
  }

  async start(target: BuildTarget): Promise<{ readonly buildId: string }> {
    if (target !== 'sim' && target !== 'esp32') fail('invalid', 'Unknown build target.');
    if (target === 'esp32') return this.startPlatformio([]);
    const build = this.reserve();
    try {
      if (!this.simRuntime) return this.launch(build, this.simDriver, [build.dir], 'HAL build-sim');
      return this.launch(
        build,
        this.simRuntime.executable,
        [this.simDriver, build.dir],
        'HAL build-sim',
        undefined,
        { ELECTRON_RUN_AS_NODE: '1', RCSIM_HAL_CACHE: this.simRuntime.cacheDir },
      );
    } catch (error) {
      this.active = undefined;
      throw error;
    }
  }

  async startUpload(
    port: string,
    upload: UploadPreparation,
  ): Promise<{ readonly buildId: string }> {
    return this.startPlatformio(['-t', 'upload', '--upload-port', port], upload);
  }

  private async startPlatformio(
    args: string[],
    upload?: UploadPreparation,
  ): Promise<{ readonly buildId: string }> {
    const build = this.reserve();
    try {
      if (!this.platformio) fail('not-found', 'PlatformIO is unavailable.');
      if (upload) await upload.validatePort();
      if (build.cancelled) fail('build-failed', 'Build was cancelled.');
      const executable = await this.platformio.requirePath();
      if (build.cancelled) fail('build-failed', 'Build was cancelled.');
      if (upload) {
        await upload.releaseSerial();
        await upload.validatePort();
        if (build.cancelled) fail('build-failed', 'Build was cancelled.');
      }
      return this.launch(
        build,
        executable,
        ['run', '-e', 'esp32dev', ...args],
        'PlatformIO',
        upload?.releaseUpload,
      );
    } catch (error) {
      this.active = undefined;
      throw error;
    }
  }

  private reserve(): ActiveBuild {
    if (this.active) fail('busy', 'A build is already running.');
    const build = { dir: this.project.requireProject().dir, id: randomUUID(), cancelled: false };
    this.active = build;
    return build;
  }

  private launch(
    build: ActiveBuild,
    executable: string,
    args: string[],
    driver: string,
    onFinished?: () => void,
    envOverrides?: NodeJS.ProcessEnv,
  ): { readonly buildId: string } {
    const { dir, id: buildId } = build;
    const started = performance.now();
    // No shell interpolation: project paths can contain spaces and shell metacharacters.
    const child = spawn(executable, args, {
      cwd: dir,
      env: {
        ...process.env,
        LC_ALL: 'C',
        LC_MESSAGES: 'C',
        LANGUAGE: 'C',
        ...envOverrides,
      },
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    build.child = child;
    const output: Record<'stdout' | 'stderr', string> = { stdout: '', stderr: '' };
    let finished = false;
    const done = (exitCode: number | null): void => {
      if (finished) return;
      finished = true;
      clearTimeout(build.cancelTimer);
      this.active = undefined;
      onFinished?.();
      this.events.emit({
        kind: 'done',
        buildId,
        ok: exitCode === 0 && !build.cancelled,
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
        text: `Could not start ${driver}: ${errorText(error)}\n`,
      });
      done(null);
    });
    child.once('close', done);
    return { buildId };
  }
  async cancel(buildId: string): Promise<void> {
    const build = this.active;
    if (build?.id !== buildId || build.cancelled) return;
    build.cancelled = true;
    const { child } = build;
    if (!child) return;
    this.signal(child, 'SIGTERM');
    build.cancelTimer = setTimeout(() => this.signal(child, 'SIGKILL'), 1000);
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
    const build = this.active;
    if (!build) return;
    build.cancelled = true;
    clearTimeout(build.cancelTimer);
    if (build.child) this.signal(build.child, 'SIGKILL');
  }
}
