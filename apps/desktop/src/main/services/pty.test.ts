import { expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectService } from './project.ts';
import { PtyService } from './pty.ts';

it('runs a real login shell in the project, resizes, and exits', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rcsim-pty-'));
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
