import { chmod } from 'node:fs/promises';
import { join } from 'node:path';

export default async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const resources = join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`,
    'Contents',
    'Resources',
    'app.asar.unpacked',
  );
  for (const arch of ['arm64', 'x64']) {
    const helper = join(
      resources,
      'node_modules',
      'node-pty',
      'prebuilds',
      `darwin-${arch}`,
      'spawn-helper',
    );
    await chmod(helper, 0o755).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}
