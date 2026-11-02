import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { access, chmod, mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ensurePtyHelperExecutable,
  ptyHelperPath,
  selectShell,
  unpackPtyPath,
} from './pty-support.ts';

describe('PTY platform support', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await realpath(await mkdtemp(join(tmpdir(), 'rcsim-pty-support-')));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  it('repairs a 0644 spawn-helper before use and is safe to repeat', async () => {
    const helper = join(dir, 'spawn-helper');
    await writeFile(helper, '#!/bin/sh\nexit 0\n');
    await chmod(helper, 0o644);
    await expect(access(helper, constants.X_OK)).rejects.toThrow();
    await ensurePtyHelperExecutable(helper);
    expect((await stat(helper)).mode & 0o777).toBe(0o755);
    await ensurePtyHelperExecutable(helper);
    await expect(access(helper, constants.X_OK)).resolves.toBeUndefined();
  });
  it('uses the native loader directory and unpacks ASAR paths without doubling the suffix', () => {
    expect(ptyHelperPath()).toMatch(
      /\/(?:build\/(?:Release|Debug)|prebuilds\/[^/]+)\/spawn-helper$/,
    );
    expect(
      unpackPtyPath(
        '/Applications/Car.app/Contents/Resources/app.asar/node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper',
      ),
    ).toBe(
      '/Applications/Car.app/Contents/Resources/app.asar.unpacked/node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper',
    );
    expect(unpackPtyPath('/app.asar.unpacked/node_modules.asar/pty/spawn-helper')).toBe(
      '/app.asar.unpacked/node_modules.asar.unpacked/pty/spawn-helper',
    );
  });
  it('validates shell executability and falls back for missing/non-executable/non-absolute candidates', async () => {
    const executable = join(dir, 'shell');
    await writeFile(executable, '#!/bin/sh\n');
    await chmod(executable, 0o755);
    expect(await selectShell(executable)).toBe(executable);
    await chmod(executable, 0o644);
    for (const candidate of [executable, join(dir, 'missing'), dir, '', 'bash']) {
      expect(await selectShell(candidate, 'linux')).toBe('/bin/sh');
    }
    // The real PTY test exercises this fallback on macOS CI as well.
    if (process.platform === 'darwin') expect(await selectShell('', 'darwin')).toBe('/bin/zsh');
  });
});
