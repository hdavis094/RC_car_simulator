import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const desktopDir = join(import.meta.dirname, '..', 'apps', 'desktop');
// `require('electron')` from the app package returns the Electron binary path.
const electronBinary = createRequire(join(desktopDir, 'package.json'))('electron') as string;

// Tools that are themselves Electron apps (T3 Code, VS Code) export
// ELECTRON_RUN_AS_NODE=1, which would start Electron as plain Node.
const env = Object.fromEntries(
  Object.entries(process.env).filter(
    (entry): entry is [string, string] =>
      entry[0] !== 'ELECTRON_RUN_AS_NODE' && entry[1] !== undefined,
  ),
);

let app: ElectronApplication;

test.beforeAll(async () => {
  app = await electron.launch({
    executablePath: electronBinary,
    env,
    // Linux CI runners can't use Chromium's setuid sandbox.
    args: [...(process.platform === 'linux' ? ['--no-sandbox'] : []), desktopDir],
  });
});

test.afterAll(async () => {
  await app?.close();
});

test('the app launches and reaches all three environments', async () => {
  const window = await app.firstWindow();
  await expect(window).toHaveTitle('Donkey Car Simulator');

  const nav = window.getByRole('navigation', { name: 'Environments' });
  await expect(window.getByRole('heading', { name: 'Workbench' })).toBeVisible();

  for (const name of ['Terminal', '3D World', 'Workbench']) {
    await nav.getByRole('button', { name }).click();
    await expect(window.getByRole('heading', { name })).toBeVisible();
    await expect(nav.getByRole('button', { name })).toHaveAttribute('aria-pressed', 'true');
  }
});
