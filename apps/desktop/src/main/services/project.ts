import { cp, mkdir, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { watch, type FSWatcher } from 'chokidar';
import {
  Car,
  defaultCatalog,
  exampleCar,
  generateCarConfigHeader,
  PartDefinition,
} from '@rcsim/schema';
import type {
  CarReadResult,
  FileChange,
  FileEntry,
  ProjectApi,
  ProjectInfo,
} from '../../shared/ipc.ts';
import { fail } from './errors.ts';
import { Signal } from './events.ts';

const ignored = new Set(['.git', '.rcsim', '.pio', 'node_modules']);
const inside = (root: string, path: string): boolean => {
  const rel = relative(root, path);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
};

export interface ProjectOptions {
  readonly templateDir: string;
  readonly recentFile: string;
  readonly pickFolder: () => Promise<string | null>;
}

export class ProjectService implements ProjectApi {
  private project: ProjectInfo | null = null;
  private watcher: FSWatcher | undefined;
  private readonly changes = new Signal<[FileChange]>();
  readonly onFileChange = this.changes.subscribe;
  private recents: ProjectInfo[] = [];
  private loadedRecent = false;

  private readonly options: ProjectOptions;
  constructor(options: ProjectOptions) {
    this.options = options;
  }

  requireProject(): ProjectInfo {
    return this.project ?? fail('no-project', 'Open a car project first.');
  }

  /** Reject traversal and symlinks outside the project, including new-file parents. */
  async resolvePath(path: string): Promise<string> {
    const root = this.requireProject().dir;
    if (
      typeof path !== 'string' ||
      !path ||
      path.includes('\\') ||
      path.includes('\0') ||
      isAbsolute(path)
    ) {
      fail('invalid', 'Expected a project-relative path with / separators.');
    }
    const target = resolve(root, path);
    if (!inside(root, target) || target === root) fail('invalid', 'Path escapes the car project.');
    let ancestor = target;
    for (;;) {
      try {
        const actual = await realpath(ancestor);
        if (!inside(root, actual)) fail('invalid', 'Symlink escapes the car project.');
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        const parent = dirname(ancestor);
        if (parent === ancestor) throw error;
        ancestor = parent;
      }
    }
    return target;
  }

  async open(dir?: string): Promise<ProjectInfo | null> {
    const selected = dir ?? (await this.options.pickFolder());
    if (!selected) return null;
    const root = await realpath(resolve(selected));
    if (!(await stat(root)).isDirectory()) fail('invalid', 'Choose a car project folder.');
    let name = basename(root);
    try {
      name = Car.parse(JSON.parse(await readFile(join(root, 'car.json'), 'utf8'))).name;
    } catch {
      /* Invalid car files remain editable. */
    }
    await this.watcher?.close();
    this.project = { dir: root, name };
    this.watcher = watch(root, {
      ignoreInitial: true,
      followSymlinks: false,
      ignored: (path) =>
        relative(root, path)
          .split(sep)
          .some((part) => ignored.has(part)),
      awaitWriteFinish: { stabilityThreshold: 80, pollInterval: 20 },
    });
    this.watcher.on('all', (event, path) => {
      if (!['add', 'addDir', 'change', 'unlink', 'unlinkDir'].includes(event)) return;
      this.changes.emit({
        kind: event.startsWith('unlink') ? 'remove' : event === 'change' ? 'change' : 'add',
        path: relative(root, path).split(sep).join('/'),
      });
    });
    this.watcher.on('error', () => {
      /* File operations still work if the OS watcher limit is reached. */
    });
    await this.recent();
    this.recents = [this.project, ...this.recents.filter((p) => p.dir !== root)].slice(0, 10);
    await mkdir(dirname(this.options.recentFile), { recursive: true });
    await writeFile(this.options.recentFile, JSON.stringify(this.recents, null, 2));
    return this.project;
  }

  async create(dir: string): Promise<ProjectInfo> {
    if (typeof dir !== 'string' || !dir.trim() || !isAbsolute(dir))
      fail('invalid', 'Enter an absolute path for the new car project.');
    const root = resolve(dir);
    try {
      if ((await readdir(root)).length > 0)
        fail('invalid', 'The new car project folder must be empty.');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await mkdir(root, { recursive: true });
    await cp(this.options.templateDir, root, {
      recursive: true,
      filter: (source) =>
        !['node_modules', 'package.json', 'README.md', '.git', '.rcsim', '.pio'].includes(
          basename(source),
        ),
    });
    try {
      await stat(join(root, 'car.json'));
    } catch {
      await writeFile(join(root, 'car.json'), `${JSON.stringify(exampleCar, null, 2)}\n`);
    }
    const project = await this.open(root);
    if (!project) return fail('io', 'Could not open the new car project.');
    const car = await this.readCar();
    if (car.ok) await this.writeCar(car.car);
    return project;
  }

  async current(): Promise<ProjectInfo | null> {
    return this.project;
  }
  async recent(): Promise<readonly ProjectInfo[]> {
    if (!this.loadedRecent) {
      try {
        const data: unknown = JSON.parse(await readFile(this.options.recentFile, 'utf8'));
        if (Array.isArray(data))
          this.recents = data
            .filter(
              (p): p is ProjectInfo =>
                typeof p === 'object' &&
                p !== null &&
                typeof p.dir === 'string' &&
                typeof p.name === 'string',
            )
            .slice(0, 10);
      } catch {
        /* First launch, or a damaged recent list. */
      }
      this.loadedRecent = true;
    }
    return this.recents;
  }
  async readCar(): Promise<CarReadResult> {
    this.requireProject();
    let raw = '';
    try {
      raw = await this.readFile('car.json');
      return { ok: true, car: Car.parse(JSON.parse(raw)) };
    } catch (error) {
      return { ok: false, raw, error: error instanceof Error ? error.message : String(error) };
    }
  }
  async writeCar(input: Car): Promise<void> {
    const parsed = Car.safeParse(input);
    if (!parsed.success) fail('invalid', parsed.error.message);
    const catalog = new Map(defaultCatalog);
    for (const entry of await this.listFiles()) {
      if (entry.kind !== 'file' || !/^parts\/[^/]+\.json$/i.test(entry.path)) continue;
      try {
        const part = PartDefinition.parse(JSON.parse(await this.readFile(entry.path)));
        if (!catalog.has(part.id)) catalog.set(part.id, part);
      } catch {
        /* CatalogService reports invalid custom parts. */
      }
    }
    await this.writeFile('car.json', `${JSON.stringify(parsed.data, null, 2)}\n`);
    await this.writeFile('include/car_config.h', generateCarConfigHeader(parsed.data, catalog));
    if (this.project) this.project = { ...this.project, name: parsed.data.name };
  }
  async listFiles(): Promise<readonly FileEntry[]> {
    const root = this.requireProject().dir;
    const entries: FileEntry[] = [];
    const visit = async (dir: string): Promise<void> => {
      for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) =>
        a.name.localeCompare(b.name),
      )) {
        if (ignored.has(entry.name) || entry.isSymbolicLink()) continue;
        const absolute = join(dir, entry.name);
        if (!entry.isDirectory() && !entry.isFile()) continue;
        entries.push({
          path: relative(root, absolute).split(sep).join('/'),
          kind: entry.isDirectory() ? 'dir' : 'file',
        });
        if (entry.isDirectory()) await visit(absolute);
      }
    };
    await visit(root);
    return entries;
  }
  async readFile(path: string): Promise<string> {
    return readFile(await this.resolvePath(path), 'utf8');
  }
  async writeFile(path: string, content: string): Promise<void> {
    if (typeof content !== 'string') fail('invalid', 'File content must be text.');
    const target = await this.resolvePath(path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content, 'utf8');
  }
  async dispose(): Promise<void> {
    await this.watcher?.close();
  }
}
