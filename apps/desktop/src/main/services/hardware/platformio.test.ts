import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PlatformioService } from './platformio.ts';

async function executable(path: string, source: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `#!/bin/sh\n${source}`);
  await chmod(path, 0o700);
}

describe('PlatformIO discovery and installation', () => {
  let dir: string;
  let bin: string;
  let data: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'rcsim platformio $; '));
    bin = join(dir, 'bin');
    data = join(dir, 'app data');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('uses an existing PlatformIO Core and ignores an unusable launcher', async () => {
    const confirm = vi.fn(async () => true);
    await executable(join(bin, 'pio'), 'exit 1\n');
    await executable(join(bin, 'platformio'), 'printf "PlatformIO Core, version 6.2.0\\n"\n');
    const platformio = new PlatformioService(data, confirm, [bin]);
    expect(await platformio.requirePath()).toBe(join(bin, 'platformio'));
    await platformio.installPlatformio();
    expect(confirm).not.toHaveBeenCalled();
  });

  it('requires confirmation and reports a missing Python prerequisite', async () => {
    const confirm = vi
      .fn<() => Promise<boolean>>()
      .mockResolvedValueOnce(false)
      .mockResolvedValue(true);
    const platformio = new PlatformioService(data, confirm, [bin]);
    await expect(platformio.requirePath()).rejects.toThrow('PlatformIO is required');
    await expect(platformio.installPlatformio()).rejects.toThrow(
      'Install Python 3 with venv and pip',
    );
    expect(confirm).toHaveBeenCalledTimes(2);
  });

  it('creates one app-owned environment and runs pip inside it with separate arguments', async () => {
    const confirm = vi.fn(async () => true);
    await executable(
      join(bin, 'python3'),
      `
set -eu
test "$#" -eq 3 && test "$1" = -m && test "$2" = venv
mkdir -p "$3/bin"
cat > "$3/bin/python" <<'PYTHON'
#!/bin/sh
set -eu
bin_dir=$(dirname "$0")
printf '%s\\n' "$@" > "$bin_dir/pip-args"
cat > "$bin_dir/pio" <<'PIO'
#!/bin/sh
test "$1" = --version && printf 'PlatformIO Core, version 6.2.0\\n'
PIO
chmod +x "$bin_dir/pio"
PYTHON
chmod +x "$3/bin/python"
`,
    );
    const platformio = new PlatformioService(data, confirm, [bin]);
    await Promise.all([platformio.installPlatformio(), platformio.installPlatformio()]);
    const venvBin = join(data, 'platformio', 'venv', 'bin');
    expect(await platformio.platformioPath()).toBe(join(venvBin, 'pio'));
    expect(await readFile(join(venvBin, 'pip-args'), 'utf8')).toBe(
      '-m\npip\n--isolated\n--disable-pip-version-check\ninstall\nplatformio\n',
    );
    expect(confirm).toHaveBeenCalledTimes(1);
  });
});
