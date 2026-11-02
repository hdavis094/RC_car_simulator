import * as nodePty from 'node-pty';
import { expect, it, vi } from 'vitest';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectService } from './project.ts';
import { PtyService } from './pty.ts';

it('runs a real login shell in the project, resizes, and exits', async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'rcsim-pty-')));
  const project = new ProjectService({
    templateDir: '',
    recentFile: join(dir, 'recent.json'),
    pickFolder: async () => null,
  });
  const service = new PtyService(project);
  try {
    await project.open(dir);
    let output = '';
    let exit: number | undefined;
    service.onData((_id, data) => {
      output += data;
    });
    service.onExit((_id, code) => {
      exit = code;
    });
    const { ptyId } = await service.spawn({ cols: 80, rows: 24 });
    await service.resize(ptyId, 90, 30);
    await service.write(ptyId, 'pwd\r');
    await expect.poll(() => output).toContain(dir);
    await service.write(ptyId, 'exit 7\r');
    await expect.poll(() => exit).toBe(7);
    await expect(service.spawn({ cols: 0, rows: 24 })).rejects.toThrow('[rcsim:invalid]');
  } finally {
    service.dispose();
    await project.dispose();
    await rm(dir, { force: true, recursive: true });
  }
});

it('falls back to an executable login shell and cancels a pending spawn on disposal', async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'rcsim-pty-fallback-')));
  const project = new ProjectService({
    templateDir: '',
    recentFile: join(dir, 'recent.json'),
    pickFolder: async () => null,
  });
  const service = new PtyService(project);
  vi.stubEnv('SHELL', '/not-an-executable-shell');
  try {
    await project.open(dir);
    let output = '';
    service.onData((_id, text) => {
      output += text;
    });
    const { ptyId } = await service.spawn({ cols: 80, rows: 24 });
    await service.write(ptyId, "printf '__RCSIM_%s__\\n' FALLBACK\r");
    await expect.poll(() => output).toContain('__RCSIM_FALLBACK__');
    service.dispose();
    await expect(service.write(ptyId, 'pwd\r')).rejects.toThrow('[rcsim:not-found]');
    const pending = service.spawn({ cols: 80, rows: 24 });
    service.dispose();
    await expect(pending).rejects.toThrow('cancelled by renderer navigation');
  } finally {
    vi.unstubAllEnvs();
    service.dispose();
    await project.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});

it('includes shell, cwd and the selected helper when native spawn throws', async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'rcsim-pty-error-')));
  const project = new ProjectService({
    templateDir: '',
    recentFile: join(dir, 'recent.json'),
    pickFolder: async () => null,
  });
  const service = new PtyService(project);
  const nativeSpawn = vi.spyOn(nodePty, 'spawn').mockImplementationOnce(() => {
    throw new Error('posix_spawnp failed.');
  });
  try {
    await project.open(dir);
    const error = await service.spawn({ cols: 80, rows: 24 }).catch((error: unknown) => error);
    expect(String(error)).toContain('posix_spawnp failed.');
    expect(String(error)).toContain('shell=/');
    expect(String(error)).toContain(`cwd=${dir}`);
    expect(String(error)).toMatch(/helper=.*spawn-helper/);
  } finally {
    nativeSpawn.mockRestore();
    service.dispose();
    await project.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});
