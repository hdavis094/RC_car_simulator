/// <reference types="node" />
/// <reference lib="dom" />
/* eslint-disable no-restricted-imports */
import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test';
import { constants } from 'node:fs';
import { access, copyFile, mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const desktop = resolve(__dirname, '../../..');
const executablePath = createRequire(join(desktop, 'package.json'))('electron') as string;
const trackedScreenshotPath = join(__dirname, 'oval-three-cones.png');

let app: ElectronApplication;
let temp: string;
let projectDir: string;

test.beforeAll(async () => {
  temp = await realpath(await mkdtemp(join(tmpdir(), 'rcsim-world-e2e-')));
  projectDir = join(temp, 'Oval Cones Car');
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && entry[0] !== 'ELECTRON_RUN_AS_NODE',
    ),
  );
  env['RCSIM_USER_DATA_DIR'] = join(temp, 'user-data');
  await mkdir(env['RCSIM_USER_DATA_DIR']);

  app = await electron.launch({
    executablePath,
    env,
    args: [...(process.platform === 'linux' ? ['--no-sandbox'] : []), desktop],
  });
});

test.afterAll(async () => {
  if (app) {
    await app.evaluate(({ BrowserWindow }) => {
      for (const window of BrowserWindow.getAllWindows()) {
        window.webContents.removeAllListeners('will-prevent-unload');
        window.webContents.on('will-prevent-unload', (event) => event.preventDefault());
      }
    });
    await app.close();
  }
  await rm(temp, { force: true, recursive: true });
});

test('renders the 3D World oval track, places three cones, saves worlds/*.json, and captures a screenshot', async () => {
  const testInfo = test.info();
  const page = await app.firstWindow();
  await page.setViewportSize({ width: 1440, height: 900 });

  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));

  // Create a project so worlds/*.json can be saved to disk and the shared bottom panel is active
  await page.getByRole('button', { name: 'New project', exact: true }).click();
  await page.getByRole('textbox', { name: 'New project folder' }).fill(projectDir);
  await page.getByRole('button', { name: 'Create project', exact: true }).click();
  await expect(page.getByRole('button', { name: 'main.cpp', exact: true })).toBeVisible();

  // Switch to the 3D World environment
  await page
    .getByRole('navigation', { name: 'Environments' })
    .getByRole('button', { name: '3D World' })
    .click();

  await expect(page.getByRole('heading', { name: '3D World' })).toBeVisible();
  await expect(page.getByTestId('world-viewport')).toBeVisible();

  // Switch camera to top-down view, select Cone tool, and place three cones on the oval track
  await page.getByTestId('camera-mode-top-down').click();
  await page.getByTestId('palette-tool-cone').click();

  const pointerLayer = page.getByTestId('world-ground');
  const box = await pointerLayer.boundingBox();
  expect(box).not.toBeNull();

  // Place 3 cones along the oval track straight ahead of the car
  await page.mouse.click(box!.x + box!.width * 0.545, box!.y + box!.height * 0.44);
  await page.mouse.click(box!.x + box!.width * 0.542, box!.y + box!.height * 0.38);
  await page.mouse.click(box!.x + box!.width * 0.548, box!.y + box!.height * 0.32);

  await expect(page.getByTestId('obstacle-marker-cone-1')).toBeVisible();
  await expect(page.getByTestId('obstacle-marker-cone-2')).toBeVisible();
  await expect(page.getByTestId('obstacle-marker-cone-3')).toBeVisible();

  // Switch to Orbit camera so the 3D oval track, car, and three cones are clearly visible in perspective
  await page.getByTestId('camera-mode-orbit').click();
  await page.getByTestId('palette-tool-select').click();

  // Open the Network Console tab in the shared bottom panel
  await page.getByTestId('bottom-tab-network-console').click();
  await expect(page.getByTestId('network-console')).toBeVisible();

  // Save the world file to disk in worlds/oval-cones.json
  await page.getByTestId('world-save-btn').click();
  await expect(page.getByTestId('world-status-message')).toContainText(
    'Saved worlds/oval-cones.json',
  );

  const savedJson = JSON.parse(
    await readFile(join(projectDir, 'worlds/oval-cones.json'), 'utf8'),
  ) as {
    trackId: string;
    obstacles: Array<{ id: string; type: string }>;
  };
  expect(savedJson.trackId).toBe('oval');
  expect(savedJson.obstacles.map((o) => ({ id: o.id, type: o.type }))).toEqual([
    { id: 'cone-1', type: 'cone' },
    { id: 'cone-2', type: 'cone' },
    { id: 'cone-3', type: 'cone' },
  ]);

  // Wait briefly for R3F WebGL canvas frames to settle before taking the screenshot
  await page.waitForTimeout(300);

  const outputScreenshot = testInfo.outputPath('oval-three-cones.png');
  await page.screenshot({ path: outputScreenshot });
  await testInfo.attach('oval-three-cones', {
    path: outputScreenshot,
    contentType: 'image/png',
  });

  let trackedExists: boolean;
  try {
    await access(trackedScreenshotPath, constants.F_OK);
    trackedExists = true;
  } catch {
    trackedExists = false;
  }
  if (!trackedExists || process.env['RCSIM_UPDATE_SCREENSHOT'] === '1') {
    await copyFile(outputScreenshot, trackedScreenshotPath);
  }

  expect(errors).toEqual([]);
});
