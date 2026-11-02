import { constants } from 'node:fs';
import { access, chmod, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, resolve } from 'node:path';

const requirePty = createRequire(import.meta.url);

export function unpackPtyPath(path: string): string {
  return path.replace(/(app|node_modules)\.asar(?=\/|$)/g, '$1.asar.unpacked');
}

/** Match node-pty 1.1's native loader (Release, Debug, then host prebuild).
 * Using its selected directory avoids repairing an unused prebuild when a
 * locally compiled addon is loaded. The helper must live outside ASAR.
 */
export function ptyHelperPath(): string {
  const loader = requirePty('node-pty/lib/utils.js') as {
    loadNativeModule(name: string): { dir: string };
  };
  const native = loader.loadNativeModule('pty');
  return unpackPtyPath(
    resolve(
      dirname(requirePty.resolve('node-pty/lib/unixTerminal.js')),
      native.dir,
      'spawn-helper',
    ),
  );
}

/** node-pty 1.1's Darwin tarballs ship spawn-helper with mode 0644. */
export async function ensurePtyHelperExecutable(path: string): Promise<void> {
  const info = await stat(path);
  if (!info.isFile()) throw new Error('The node-pty spawn helper is not a file.');
  try {
    await access(path, constants.X_OK);
  } catch {
    await chmod(path, info.mode | 0o111);
    await access(path, constants.X_OK);
  }
}

export async function selectShell(
  candidate = process.env['SHELL'],
  platform = process.platform,
): Promise<string> {
  const executable = async (path: string): Promise<boolean> => {
    try {
      return (
        isAbsolute(path) &&
        (await stat(path)).isFile() &&
        (await access(path, constants.X_OK).then(() => true))
      );
    } catch {
      return false;
    }
  };
  if (candidate && (await executable(candidate))) return candidate;
  const fallback = platform === 'darwin' ? '/bin/zsh' : '/bin/sh';
  if (!(await executable(fallback)))
    throw new Error(`Fallback shell is not executable: ${fallback}`);
  return fallback;
}
