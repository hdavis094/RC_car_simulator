/// <reference lib="dom" />
import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const desktopDir = join(import.meta.dirname, '..', 'apps', 'desktop');
const electronBinary = createRequire(join(desktopDir, 'package.json'))('electron') as string;

let app: ElectronApplication;
let tempDir: string;
let projectDir: string;

test.beforeAll(async () => {
  tempDir = await realpath(await mkdtemp(join(tmpdir(), 'rcsim-demo-e2e-')));
  projectDir = join(tempDir, 'Demo car');
  const userDataDir = join(tempDir, 'user-data');
  await mkdir(userDataDir);

  // Tools that are themselves Electron apps export ELECTRON_RUN_AS_NODE=1,
  // which would start Electron as plain Node instead of the desktop app.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[0] !== 'ELECTRON_RUN_AS_NODE' && entry[1] !== undefined,
    ),
  );
  env['RCSIM_USER_DATA_DIR'] = userDataDir;

  // Match world.playwright.ts GPU/ANGLE flags so WebGL works on headless Linux
  // CI without breaking ANGLE initialization on macOS runners.
  const launchArgs = [
    ...(process.platform === 'linux'
      ? [
          '--no-sandbox',
          process.env['DISPLAY'] ? '--ozone-platform=x11' : '--ozone-platform=headless',
          '--use-gl=angle',
          '--use-angle=swiftshader',
          '--enable-unsafe-swiftshader',
        ]
      : process.platform === 'darwin'
        ? ['--ignore-gpu-blocklist']
        : ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader']),
    desktopDir,
  ];

  app = await electron.launch({
    executablePath: electronBinary,
    env,
    args: launchArgs,
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
  await rm(tempDir, { force: true, recursive: true });
});

test('v1 demo: new project, Workbench, Terminal build, 3D World run, telemetry, manual drive, and stop', async () => {
  // Cold builds compile hal and the starter firmware from scratch.
  test.setTimeout(180_000);

  const page = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win) win.setContentSize(1440, 900);
  });
  await page.setViewportSize({ width: 1440, height: 900 });

  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));

  const nav = page.getByRole('navigation', { name: 'Environments' });

  // 1. New project from starter firmware
  await page.getByRole('button', { name: 'New project', exact: true }).click();
  await page.getByRole('textbox', { name: 'New project folder' }).fill(projectDir);
  await page.getByRole('button', { name: 'Create project', exact: true }).click();
  await expect(page.getByRole('button', { name: 'main.cpp', exact: true })).toBeVisible();

  // 2. Workbench shows zero wiring errors
  await nav.getByRole('button', { name: 'Workbench', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Workbench' })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Car name' })).toHaveValue('Default car');
  await expect(page.getByTestId('workbench-wiring-badge')).toHaveText('0 errors');
  await expect(page.getByTestId('wiring-summary-counts')).toHaveText('0 errors, 0 warnings');
  await expect(page.getByTestId('wiring-issues-summary')).toContainText('No wiring issues');

  // 3. Terminal Build succeeds
  await nav.getByRole('button', { name: 'Terminal', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Terminal' })).toBeVisible();
  await page.getByRole('button', { name: 'Build for Sim', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Build succeeded' })).toBeVisible({
    timeout: 150_000,
  });

  // 4. 3D World: place a cone
  await nav.getByRole('button', { name: '3D World', exact: true }).click();
  await expect(page.getByRole('heading', { name: '3D World' })).toBeVisible();
  const viewport = page.getByTestId('world-viewport');
  await expect(viewport).toBeVisible();
  await expect
    .poll(async () => await viewport.getAttribute('data-ready'), { timeout: 20_000 })
    .not.toBe('false');

  await page.getByTestId('camera-mode-top-down').click();
  await page.getByTestId('palette-tool-cone').click();
  // Place the cone along the straight edge so it is visible on the track
  // without blocking the straight-ahead manual drive check below.
  await page.getByRole('spinbutton', { name: 'Placement X (m)' }).fill('2.0');
  await page.getByRole('spinbutton', { name: 'Placement Z (m)' }).fill('-2.5');
  const ground = page.getByTestId('world-ground');
  await expect.poll(async () => (await ground.boundingBox()) !== null).toBe(true);
  const groundBox = await ground.boundingBox();
  expect(groundBox).not.toBeNull();
  await page.mouse.click(groundBox!.x + groundBox!.width / 2, groundBox!.y + groundBox!.height / 2);
  await expect(page.getByTestId('obstacle-marker-cone-1')).toBeVisible();
  await page.getByTestId('palette-tool-select').click();

  // 5. Run
  await page.getByTestId('run-play-pause-btn').click();
  await expect(page.getByTestId('run-play-pause-btn')).toHaveText('Pause', { timeout: 30_000 });
  await expect(page.locator('footer.status-bar')).toContainText('Run: running');

  const dock = page.getByLabel('Shared bottom panel');

  // 6. Serial Monitor shows the starter firmware's boot banner
  await dock.getByRole('tab', { name: 'Serial Monitor', exact: true }).click();
  await expect(page.getByLabel('Serial output')).toContainText('Donkey Car starter firmware', {
    timeout: 20_000,
  });

  // 7. Network Console shows telemetry
  await dock.getByRole('tab', { name: 'Network Console', exact: true }).click();
  await expect(page.getByTestId('telemetry-connection')).toContainText('connected', {
    timeout: 20_000,
  });
  await expect(page.getByTestId('network-console-log')).toContainText('"t": "telemetry"', {
    timeout: 20_000,
  });

  // Exercise a firmware-confirmed mode change before driving via the keyboard.
  await page.getByRole('button', { name: 'Auto mode', exact: true }).click();
  await expect(page.getByTestId('telemetry-mode')).toContainText('auto', { timeout: 10_000 });
  await page.getByRole('button', { name: 'Manual mode', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Manual mode', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(page.getByTestId('telemetry-mode')).toContainText('manual', { timeout: 10_000 });

  // Starter firmware holds neutral for 3.0 s of sim time while the ESC arms.
  const readSimTimeSec = async (): Promise<number> => {
    const text = await page.getByTestId('sim-time-display').innerText();
    const match = /Sim time:\s*([0-9.]+)\s*s/.exec(text);
    return match ? Number(match[1]) : 0;
  };
  await expect.poll(readSimTimeSec, { timeout: 20_000 }).toBeGreaterThanOrEqual(3.1);

  const carZBeforeDrive = Number(await viewport.getAttribute('data-car-z'));
  expect(Number.isFinite(carZBeforeDrive)).toBe(true);

  await page.keyboard.down('w');
  try {
    await expect(page.getByTestId('drive-command-readout')).toContainText('T: 1.00', {
      timeout: 5_000,
    });
    await expect
      .poll(async () => Number(await viewport.getAttribute('data-car-z')), {
        timeout: 10_000,
        message: 'Expected car data-car-z to move toward -Z while holding W in manual mode',
      })
      .toBeLessThan(carZBeforeDrive - 0.1);
  } finally {
    await page.keyboard.up('w');
  }

  // 9. Stop -> RunInfo.state is ended
  await page.getByTestId('run-stop-btn').click();
  await expect(page.locator('footer.status-bar')).toContainText('Run: ended', {
    timeout: 15_000,
  });
  await expect(page.getByTestId('run-play-pause-btn')).toHaveText('Run');
  await expect(page.getByTestId('run-stop-btn')).toBeDisabled();
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const win = globalThis as unknown as {
          rcsim: { run: { info: () => Promise<{ state: string } | null> } };
        };
        return await win.rcsim.run.info();
      }),
    )
    .toMatchObject({ state: 'ended' });

  expect(errors).toEqual([]);
});
