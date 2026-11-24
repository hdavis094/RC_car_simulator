import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, mkdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import { errorText, fail } from '../errors.ts';

const execute = promisify(execFile);

function executableDirectories(): string[] {
  const home = homedir();
  return [
    ...(process.env['PATH'] ?? '').split(delimiter).filter(isAbsolute),
    join(home, '.platformio', 'penv', 'bin'),
    join(home, '.local', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
  ];
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    if (!(await stat(path)).isFile()) return false;
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export class PlatformioService {
  private readonly environment: string;
  private readonly confirmInstallation: () => Promise<boolean>;
  private readonly searchDirs: readonly string[];
  private installation: Promise<void> | undefined;

  constructor(
    dataDir: string,
    confirmInstallation: () => Promise<boolean>,
    searchDirs = executableDirectories(),
  ) {
    this.environment = join(dataDir, 'platformio', 'venv');
    this.confirmInstallation = confirmInstallation;
    this.searchDirs = searchDirs;
  }

  async platformioPath(): Promise<string | null> {
    const candidates = new Set([
      join(this.environment, 'bin', 'pio'),
      ...this.searchDirs.flatMap((dir) => [join(dir, 'pio'), join(dir, 'platformio')]),
    ]);
    for (const path of candidates) {
      if (!(await isExecutable(path))) continue;
      try {
        const { stdout } = await execute(path, ['--version'], { timeout: 5000 });
        if (/\bPlatformIO Core\b/i.test(stdout)) return path;
      } catch {
        // An old launcher can outlive the Python environment it points to.
      }
    }
    return null;
  }

  async requirePath(): Promise<string> {
    if (this.installation) await this.installation;
    else {
      const existing = await this.platformioPath();
      if (existing) return existing;
      await this.installPlatformio();
    }
    const installed = await this.platformioPath();
    if (!installed)
      fail('not-found', 'PlatformIO is required. Use Install PlatformIO in Terminal.');
    return installed;
  }

  async installPlatformio(): Promise<void> {
    this.installation ??= this.install().finally(() => {
      this.installation = undefined;
    });
    await this.installation;
  }

  private async install(): Promise<void> {
    if ((await this.platformioPath()) || !(await this.confirmInstallation())) return;
    const candidates = this.searchDirs.map((dir) => join(dir, 'python3'));
    const available = await Promise.all(candidates.map(isExecutable));
    const python = candidates.find((_path, index) => available[index]);
    if (!python) {
      fail('not-found', 'Install Python 3 with venv and pip, then retry Install PlatformIO.');
    }
    const options = { timeout: 180_000, maxBuffer: 2 * 1024 * 1024 };
    await mkdir(this.environment, { recursive: true });
    try {
      await execute(python, ['-m', 'venv', this.environment], options);
    } catch (error) {
      fail(
        'io',
        `Could not create the PlatformIO Python environment. Install Python 3 with venv and pip (python3-venv on Debian/Ubuntu), then retry.\n${errorText(error)}`,
      );
    }
    try {
      await execute(
        join(this.environment, 'bin', 'python'),
        ['-m', 'pip', '--isolated', '--disable-pip-version-check', 'install', 'platformio'],
        options,
      );
    } catch (error) {
      fail(
        'io',
        `Could not install PlatformIO Core. Check access to PyPI and retry.\n${errorText(error)}`,
      );
    }
    if (!(await this.platformioPath())) {
      fail('io', 'PlatformIO Core was installed but could not run. Check Python 3 and retry.');
    }
  }
}
