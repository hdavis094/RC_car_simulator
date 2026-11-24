import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, expect } from '@playwright/test';

const appPath = process.argv[2];
if (!appPath) throw new Error('Pass the unpacked package executable.');
const directory = await realpath(await mkdtemp(join(tmpdir(), 'rcsim package smoke-')));
const project = join(directory, 'Firmware project');
const env = { ...process.env, XDG_CONFIG_HOME: join(directory, 'config') };
delete env.ELECTRON_RUN_AS_NODE;
await mkdir(env.XDG_CONFIG_HOME);
let app;
try {
  app = await electron.launch({
    executablePath: resolve(appPath),
    env,
    args: process.platform === 'linux' ? ['--no-sandbox', '--disable-dev-shm-usage'] : [],
  });
  const page = await app.firstWindow();
  await expect(page).toHaveTitle('Donkey Car Simulator');
  if (!(await app.evaluate(({ app: instance }) => instance.isPackaged))) {
    throw new Error('The smoke test must use a packaged app.');
  }
  await page.getByRole('button', { name: 'New project', exact: true }).click();
  await page.getByRole('textbox', { name: 'New project folder' }).fill(project);
  await page.getByRole('button', { name: 'Create project', exact: true }).click();
  await expect(page.getByRole('button', { name: 'main.cpp', exact: true })).toBeVisible();
  const ports = await page.evaluate(() => window.rcsim.hardware.listSerialPorts());
  if (!Array.isArray(ports)) throw new Error('The packaged USB serial service is unavailable.');
  const { ptyId } = await page.evaluate(() => window.rcsim.pty.spawn({ cols: 80, rows: 24 }));
  await page.evaluate((id) => window.rcsim.pty.kill(id), ptyId);

  await page.getByRole('button', { name: '3D World', exact: true }).click();
  await page.getByTestId('run-play-pause-btn').click();
  await expect(page.locator('footer.status-bar')).toContainText('Run: running', {
    timeout: 180_000,
  });
  await page.getByRole('tab', { name: 'Serial Monitor', exact: true }).click();
  await expect(page.getByLabel('Serial output')).toContainText('Donkey Car starter firmware', {
    timeout: 20_000,
  });
  await page.getByTestId('run-stop-btn').click();
  await expect(page.locator('footer.status-bar')).toContainText('Run: ended');
  console.log('The packaged app created a project and ran its starter firmware.');
} finally {
  try {
    await app?.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
