import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmod, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { BuildEvent } from '../../shared/ipc.ts';
import { BuildService, parseDiagnostics } from './build.ts';
import { ProjectService } from './project.ts';

describe('BuildService', () => {
  let dir: string;
  let project: ProjectService;
  let build: BuildService;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'rcsim-build-'));
    await mkdir(join(dir, 'src'));
    project = new ProjectService({
      templateDir: '',
      recentFile: join(dir, 'recent.json'),
      pickFolder: async () => null,
    });
    await project.open(dir);
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    build?.dispose();
    await project.dispose();
    await rm(dir, { force: true, recursive: true });
  });

  it('parses GCC and Clang, optional columns, ANSI, and external paths', () => {
    expect(
      parseDiagnostics(
        '\u001b[31m/tmp/car/src/main.cpp:4:9: error: missing semicolon\u001b[0m\nsrc/a.cpp:8: warning: unused\n/usr/include/a.h:3:2: fatal error: missing\ncompiler summary',
        '/tmp/car',
      ),
    ).toEqual([
      { file: 'src/main.cpp', line: 4, column: 9, severity: 'error', message: 'missing semicolon' },
      { file: 'src/a.cpp', line: 8, column: 1, severity: 'warning', message: 'unused' },
      { file: '/usr/include/a.h', line: 3, column: 2, severity: 'error', message: 'missing' },
    ]);
  });
  it('normalises relative diagnostics and preserves absolute paths outside the project', () => {
    expect(
      parseDiagnostics(
        '../car/src/a.cpp:2:3: error: typo\nsrc/../main.cpp:4:5: warning: unused\n../external.cpp:6:7: note: see here',
        '/tmp/car',
      ),
    ).toEqual([
      { file: 'src/a.cpp', line: 2, column: 3, severity: 'error', message: 'typo' },
      { file: 'main.cpp', line: 4, column: 5, severity: 'warning', message: 'unused' },
      { file: '/tmp/external.cpp', line: 6, column: 7, severity: 'note', message: 'see here' },
    ]);
  });
  it('parses GNU and Apple linker failures without a source line', () => {
    expect(
      parseDiagnostics(
        "/usr/bin/ld: /tmp/car/src/foo.cpp:(.text+0x5): undefined reference to `missing()'\nld: symbol(s) not found for architecture arm64\nclang++: error: linker command failed with exit code 1",
        '/tmp/car',
      ),
    ).toEqual([
      {
        file: 'src/foo.cpp',
        line: 1,
        column: 1,
        severity: 'error',
        message: "undefined reference to `missing()'",
      },
      {
        file: '',
        line: 1,
        column: 1,
        severity: 'error',
        message: 'symbol(s) not found for architecture arm64',
      },
      {
        file: '',
        line: 1,
        column: 1,
        severity: 'error',
        message: 'linker command failed with exit code 1',
      },
    ]);
  });
  it('forces compiler messages to C regardless of the launch locale', async () => {
    for (const name of ['LC_ALL', 'LC_MESSAGES', 'LANGUAGE']) vi.stubEnv(name, 'fr_FR.UTF-8');
    const driver = join(dir, 'locale-build');
    await writeFile(driver, '#!/bin/sh\nprintf "%s|%s|%s" "$LC_ALL" "$LC_MESSAGES" "$LANGUAGE"\n');
    await chmod(driver, 0o755);
    build = new BuildService(project, driver);
    const events: BuildEvent[] = [];
    build.onEvent((event) => events.push(event));
    await build.start('sim');
    await expect.poll(() => events.some((event) => event.kind === 'done')).toBe(true);
    expect(
      events
        .filter((event) => event.kind === 'output')
        .map((event) => event.text)
        .join(''),
    ).toBe('C|C|C');
  });
  it('uses the real compiler, preserves output, reports diagnostics, and succeeds after a fix', async () => {
    const driver = join(dir, 'build-sim');
    await writeFile(
      driver,
      '#!/bin/sh\ncd "$1" || exit 1\nexec "${CXX:-c++}" -std=c++17 -fsyntax-only src/main.cpp\n',
    );
    await chmod(driver, 0o755);
    build = new BuildService(project, driver);
    const events: BuildEvent[] = [];
    build.onEvent((event) => events.push(event));
    await project.writeFile('src/main.cpp', 'void setup() {\n  typo;\n}\n');
    const first = await build.start('sim');
    await expect
      .poll(() => events.find((event) => event.kind === 'done' && event.buildId === first.buildId))
      .toMatchObject({
        ok: false,
        diagnostics: [
          expect.objectContaining({ file: 'src/main.cpp', line: 2, severity: 'error' }),
        ],
      });
    expect(events.some((event) => event.kind === 'output' && event.text.includes('typo'))).toBe(
      true,
    );
    await project.writeFile('src/main.cpp', 'void setup() {}\n');
    const second = await build.start('sim');
    await expect
      .poll(() => events.find((event) => event.kind === 'done' && event.buildId === second.buildId))
      .toMatchObject({ ok: true, exitCode: 0 });
  });
  it('cancels the compiler process group and prevents overlapping builds', async () => {
    const driver = join(dir, 'slow-build');
    await writeFile(driver, '#!/bin/sh\nsleep 30\n');
    await chmod(driver, 0o755);
    build = new BuildService(project, driver);
    const events: BuildEvent[] = [];
    build.onEvent((event) => events.push(event));
    const { buildId } = await build.start('sim');
    await expect(build.start('sim')).rejects.toThrow('[rcsim:busy]');
    await build.cancel(buildId);
    await expect
      .poll(() => events.find((event) => event.kind === 'done'))
      .toMatchObject({ ok: false });
    await expect(build.start('esp32')).rejects.toThrow('[rcsim:not-implemented]');
  });
  it('terminates the active compiler when its renderer resources are disposed', async () => {
    const driver = join(dir, 'slow-build');
    await writeFile(driver, '#!/bin/sh\nsleep 30\n');
    await chmod(driver, 0o755);
    build = new BuildService(project, driver);
    const events: BuildEvent[] = [];
    build.onEvent((event) => events.push(event));
    await build.start('sim');
    build.dispose();
    await expect
      .poll(() => events.find((event) => event.kind === 'done'))
      .toMatchObject({ ok: false });
  });
  it('finishes cleanly when the build driver is missing', async () => {
    build = new BuildService(project, join(dir, 'missing-build-sim'));
    const events: BuildEvent[] = [];
    build.onEvent((event) => events.push(event));
    await build.start('sim');
    await expect
      .poll(() => events.find((event) => event.kind === 'done'))
      .toMatchObject({ ok: false, exitCode: null });
    expect(
      events.some((event) => event.kind === 'output' && event.text.includes('Could not start HAL')),
    ).toBe(true);
  });
});
