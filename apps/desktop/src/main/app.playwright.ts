/// <reference lib="dom" />
import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test';
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { IPC_EVENTS, IPC_METHODS, parseIpcError } from '../shared/ipc.ts';

const desktop = resolve(__dirname, '../..');
const root = resolve(desktop, '../..');
const executablePath = createRequire(join(desktop, 'package.json'))('electron') as string;
let app: ElectronApplication;
let temp: string;
let projectDir: string;

test.beforeAll(async () => {
  temp = await mkdtemp(join(tmpdir(), 'rcsim-electron-'));
  projectDir = join(temp, 'My car');
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && entry[0] !== 'ELECTRON_RUN_AS_NODE',
    ),
  );
  env['RCSIM_USER_DATA_DIR'] = join(temp, 'user-data');
  await mkdir(env['RCSIM_USER_DATA_DIR']);
  try {
    await access(join(root, 'packages/hal/bin/build-sim'), constants.X_OK);
  } catch {
    // P1-C is developed in parallel. This fixture tests the entire UI/IPC/build
    // path with a real compiler, without pretending to supply a HAL runtime.
    const driver = join(temp, 'build-sim');
    await mkdir(join(temp, 'include'));
    await writeFile(
      join(temp, 'include/Arduino.h'),
      '// Syntax-only header for the P0 starter placeholder.\n',
    );
    await writeFile(
      driver,
      '#!/bin/sh\ncd "$1" || exit 1\nexec "${CXX:-c++}" -std=c++17 -fsyntax-only -I"$RCSIM_TEST_INCLUDE" src/*.cpp\n',
    );
    await chmod(driver, 0o755);
    env['RCSIM_BUILD_SIM'] = driver;
    env['RCSIM_TEST_INCLUDE'] = join(temp, 'include');
  }
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

test('creates from starter firmware, saves a typo, builds, and jumps to its exact diagnostic', async () => {
  const page = await app.firstWindow();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.getByRole('button', { name: 'New project', exact: true }).click();
  await page.getByRole('textbox', { name: 'New project folder' }).fill(projectDir);
  await page.getByRole('button', { name: 'Create project', exact: true }).click();
  await expect(page.getByRole('button', { name: 'main.cpp', exact: true })).toBeVisible();
  const original = await readFile(join(root, 'packages/firmware-template/src/main.cpp'), 'utf8');
  expect(await readFile(join(projectDir, 'src/main.cpp'), 'utf8')).toBe(original);
  await page.getByRole('button', { name: 'main.cpp', exact: true }).click();
  const editor = page.getByTestId('firmware-editor');
  await expect(editor.locator('.monaco-editor')).toBeVisible();
  await editor.click();
  const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
  await page.keyboard.press(`${modifier}+End`);
  await page.keyboard.press('End');
  await page.keyboard.insertText('\nvoid acceptance_typo() {\n  rcsim_missing_symbol;\n}\n');
  await expect(page.getByRole('tab', { name: 'main.cpp ●' })).toBeVisible();
  await page.getByRole('button', { name: 'Build for Sim', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Build failed' })).toBeVisible();
  const diagnostic = page
    .getByRole('button')
    .filter({ hasText: /src\/main.cpp:\d+:\d+.*error:.*rcsim_missing_symbol/ })
    .first();
  await expect(diagnostic).toBeVisible();
  const location = /src\/main.cpp:(\d+):(\d+)/.exec(await diagnostic.innerText());
  expect(location).not.toBeNull();
  const contents = await readFile(join(projectDir, 'src/main.cpp'), 'utf8');
  expect(contents).toContain('rcsim_missing_symbol');
  expect(contents.split('\n')[Number(location![1]) - 1]).toContain('rcsim_missing_symbol');
  await page.getByRole('tab', { name: 'main.cpp', exact: true }).click();
  await page.keyboard.press(`${modifier}+Home`);
  await diagnostic.click();
  await expect(editor).toHaveAttribute('data-line', location![1]!);
  await expect(editor).toHaveAttribute('data-column', location![2]!);
  expect(errors).toEqual([]);
});

test('a real shell runs pwd in the car project and survives environment and dock changes', async () => {
  const page = await app.firstWindow();
  await page.getByRole('button', { name: '+ Shell', exact: true }).click();
  const shell = page.getByLabel('Project shell');
  await expect(shell.locator('.xterm')).toBeVisible();
  await shell.locator('textarea').focus();
  await page.keyboard.type('pwd');
  await page.keyboard.press('Enter');
  await expect(shell.locator('.xterm-rows')).toContainText(projectDir);
  await page
    .getByRole('navigation', { name: 'Environments' })
    .getByRole('button', { name: '3D World' })
    .click();
  await expect(shell.locator('.xterm-rows')).toContainText(projectDir);
  await page.getByRole('button', { name: 'Dock right', exact: true }).click();
  await expect(page.getByLabel('Shared bottom panel')).toHaveClass(/dock-right/);
  await page.getByRole('button', { name: 'Dock bottom', exact: true }).click();
  await page.getByRole('button', { name: 'Collapse panel' }).click();
  await page.getByRole('button', { name: 'Expand panel' }).click();
  await expect(shell.locator('.xterm-rows')).toContainText(projectDir);
  await page.getByRole('button', { name: 'Close shell', exact: true }).click();
});

test('the sandbox exposes exactly the contract and stubs reject with not-implemented', async () => {
  const page = await app.firstWindow();
  expect(await page.evaluate(() => typeof require)).toBe('undefined');
  expect(await page.evaluate(() => typeof Reflect.get(window, 'process'))).toBe('undefined');
  const keys = await page.evaluate(() =>
    Object.fromEntries(
      Object.entries(window.rcsim)
        .filter(([key]) => key !== 'platform')
        .map(([key, value]) => [key, Object.keys(value).sort()]),
    ),
  );
  expect(Object.keys(keys).sort()).toEqual(Object.keys(IPC_METHODS).sort());
  for (const service of Object.keys(IPC_METHODS) as (keyof typeof IPC_METHODS)[]) {
    expect(keys[service]).toEqual([...IPC_METHODS[service], ...IPC_EVENTS[service]].sort());
  }
  const message = await page.evaluate(async () => {
    try {
      await window.rcsim.run.info();
      return '';
    } catch (error) {
      return String(error);
    }
  });
  expect(parseIpcError(message).code).toBe('not-implemented');
  // Recent projects survive a renderer reload. Current project remains in main.
  await page.reload();
  await expect(page.getByRole('combobox', { name: 'Recent projects' })).toContainText(projectDir);
});

test('file watching reloads a clean editor and preserves a dirty editor on external changes', async () => {
  const page = await app.firstWindow();
  await page
    .getByRole('navigation', { name: 'Environments' })
    .getByRole('button', { name: 'Terminal', exact: true })
    .click();
  await page.getByRole('button', { name: 'main.cpp', exact: true }).click();
  const editor = page.getByTestId('firmware-editor');
  await expect(editor.locator('.monaco-editor')).toBeVisible();
  await writeFile(
    join(projectDir, 'src/main.cpp'),
    '// external edit\nvoid setup() {}\nvoid loop() {}\n',
  );
  await expect(editor).toContainText('external edit');
  await editor.click();
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Home' : 'Control+Home');
  await page.keyboard.insertText('// unsaved\n');
  await expect(page.getByRole('tab', { name: 'main.cpp ●' })).toBeVisible();
  await writeFile(join(projectDir, 'src/main.cpp'), '// changed again\n');
  await expect(
    page.getByRole('alert').filter({ hasText: 'Your edits are preserved' }),
  ).toBeVisible();
  await expect(editor).toContainText('unsaved');
  // Resolve the conflict so closing the test app doesn't trigger the dirty guard.
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'Reload from disk' }).click();
  await expect(editor).toContainText('changed again');
});

test('Serial Monitor receives the run serial stream, keeps history between tabs, and reports the send stub', async () => {
  const page = await app.firstWindow();
  await page.getByRole('tab', { name: 'Serial Monitor', exact: true }).click();
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]!.webContents.send('run:onSerial', 'Firmware ready\n', 1000);
  });
  await expect(page.getByLabel('Serial output')).toContainText('Firmware ready');
  await expect(page.getByRole('checkbox', { name: 'Autoscroll' })).toBeChecked();
  await page.getByRole('tab', { name: 'Build output', exact: true }).click();
  await page.getByRole('tab', { name: 'Serial Monitor', exact: true }).click();
  await expect(page.getByLabel('Serial output')).toContainText('Firmware ready');
  await page.getByRole('textbox', { name: 'Serial send line' }).fill('status');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(
    page.getByRole('alert').filter({ hasText: 'run.sendSerial is not implemented' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Clear', exact: true }).click();
  await expect(page.getByLabel('Serial output')).not.toContainText('Firmware ready');
});
