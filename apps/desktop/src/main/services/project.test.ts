import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { defaultCatalog, exampleCar, generateCarConfigHeader } from '@rcsim/schema';
import { ProjectService } from './project.ts';
import { CatalogService } from './catalog.ts';

describe('ProjectService and CatalogService', () => {
  let dir: string;
  let project: ProjectService;
  let catalog: CatalogService;
  beforeEach(async () => {
    dir = await realpath(await mkdtemp(join(tmpdir(), 'rcsim-project-')));
    const templateDir = join(dir, 'template');
    await mkdir(join(templateDir, 'src'), { recursive: true });
    await writeFile(join(templateDir, 'src/main.cpp'), 'void setup() {}\nvoid loop() {}\n');
    project = new ProjectService({
      templateDir,
      recentFile: join(dir, 'settings/recent.json'),
      pickFolder: async () => null,
    });
    catalog = new CatalogService(project);
  });
  afterEach(async () => {
    catalog.dispose();
    await project.dispose();
    await rm(dir, { recursive: true, force: true });
  });

  it('creates from starter firmware, generates the header, and persists recent projects', async () => {
    const info = await project.create(join(dir, 'My car'));
    expect(info.dir).toBe(join(dir, 'My car'));
    expect(await project.readFile('src/main.cpp')).toContain('void setup()');
    expect(await project.readFile('include/car_config.h')).toBe(
      generateCarConfigHeader(exampleCar, defaultCatalog),
    );
    const car = { ...exampleCar, name: 'Another car' };
    await project.writeCar(car);
    expect(await project.readCar()).toEqual({ ok: true, car });
    expect(await project.readFile('include/car_config.h')).toBe(
      generateCarConfigHeader(car, defaultCatalog),
    );
    const next = new ProjectService({
      templateDir: '',
      recentFile: join(dir, 'settings/recent.json'),
      pickFolder: async () => null,
    });
    expect((await next.recent())[0]?.dir).toBe(info.dir);
    expect(await project.open()).toBeNull();
    expect((await project.current())?.name).toBe('Another car');
    await expect(project.create(info.dir)).rejects.toThrow('must be empty');
  });

  it('rejects traversal and symlink escapes for reads and new writes', async () => {
    await project.create(join(dir, 'car'));
    await writeFile(join(dir, 'secret'), 'outside');
    await symlink(dir, join(dir, 'car/escape'));
    await symlink(join(dir, 'not-created'), join(dir, 'car/dangling'));
    for (const path of [
      '../secret',
      '/etc/passwd',
      'escape/secret',
      'escape/new/deep/file',
      'a/../../secret',
      'a\\b',
      'dangling/file',
    ]) {
      await expect(project.readFile(path)).rejects.toThrow();
      await expect(project.writeFile(path, 'bad')).rejects.toThrow();
    }
    expect(await readFile(join(dir, 'secret'), 'utf8')).toBe('outside');
    expect((await project.listFiles()).some((entry) => entry.path.includes('escape'))).toBe(false);
  });

  it('rejects writes to the dangling symlink itself without creating an outside file', async () => {
    await project.create(join(dir, 'car'));
    const outside = join(dir, 'not-created');
    await symlink(outside, join(dir, 'car/dangling'));
    await expect(project.writeFile('dangling', 'PWNED')).rejects.toThrow('[rcsim:invalid]');
    await expect(readFile(outside, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    await project.writeFile('new/nested/file.txt', 'inside');
    expect(await project.readFile('new/nested/file.txt')).toBe('inside');
  });

  it('opens the project when recents cannot be persisted', async () => {
    await mkdir(join(dir, 'settings'), { recursive: true });
    await mkdir(join(dir, 'settings/recent.json'));
    const info = await project.create(join(dir, 'car'));
    expect(await project.current()).toEqual(info);
    expect((await project.recent())[0]).toEqual(info);
  });

  it('leaves invalid car.json editable and reports malformed and duplicate custom parts', async () => {
    await project.create(join(dir, 'car'));
    await project.writeFile('car.json', '{broken');
    expect(await project.readCar()).toMatchObject({ ok: false, raw: '{broken' });
    await project.writeFile('parts/broken.json', '{');
    const builtIn = [...defaultCatalog.values()][0]!;
    await project.writeFile('parts/duplicate.json', JSON.stringify(builtIn));
    expect((await catalog.list()).problems.map((problem) => problem.source)).toEqual([
      'parts/broken.json',
      'parts/duplicate.json',
    ]);
    await expect(catalog.saveCustomPart(builtIn)).rejects.toThrow('cannot replace');
    const definition = { ...builtIn, id: 'custom.test-part' };
    expect(await catalog.saveCustomPart(definition)).toEqual({
      path: 'parts/custom.test-part.json',
    });
    expect((await catalog.list()).custom[0]?.definition).toEqual(definition);
    await expect(catalog.saveCustomPart({ ...definition, id: '../escape' })).rejects.toThrow(
      '[rcsim:invalid]',
    );
  });

  it('watches external additions, modifications, removals, and custom catalog changes', async () => {
    await project.create(join(dir, 'car'));
    const changes: string[] = [];
    project.onFileChange((change) => changes.push(`${change.kind}:${change.path}`));
    let listings = 0;
    catalog.onChange(() => listings++);
    // Wait for the watcher to finish its initial scan before making external changes.
    await new Promise((resolve) => setTimeout(resolve, 150));
    await writeFile(join(dir, 'car/src/new.cpp'), 'one');
    await expect.poll(() => changes).toContain('add:src/new.cpp');
    await writeFile(join(dir, 'car/src/new.cpp'), 'two');
    await expect.poll(() => changes).toContain('change:src/new.cpp');
    await rm(join(dir, 'car/src/new.cpp'));
    await expect.poll(() => changes).toContain('remove:src/new.cpp');
    await project.writeFile('parts/broken.json', '{');
    await expect.poll(() => listings).toBeGreaterThan(0);
  });
});
