import { pathToFileURL } from 'node:url';
import { app, BrowserWindow, dialog, Menu, session, shell } from 'electron';
import { join, resolve } from 'node:path';
import { registerIpc } from './ipc.ts';
import { checkCompiler } from './compiler.ts';
import { disposeRendererResources } from './renderer-lifecycle.ts';
import { BuildService } from './services/build.ts';
import { CatalogService } from './services/catalog.ts';
import { ControlService } from './services/control/control-service.ts';
import { SimService } from './services/sim/sim-service.ts';
import { spawnUtilityHost } from './services/sim/utility-host.ts';
import { WorldEditService } from './services/world-edit/world-edit-service.ts';
import { ProjectService } from './services/project.ts';
import { PtyService } from './services/pty.ts';

// Tests and source-development launches may isolate Electron's persisted data.
const userDataDir = !app.isPackaged ? process.env['RCSIM_USER_DATA_DIR'] : undefined;
if (userDataDir) app.setPath('userData', userDataDir);

// Packaged apps have no system Node; run the HAL driver through Electron's own runtime.
if (app.isPackaged) {
  process.env['RCSIM_NODE'] = process.execPath;
  process.env['RCSIM_HAL_CACHE'] = join(app.getPath('userData'), 'hal-build');
}

function createWindow(): BrowserWindow {
  const root = app.isPackaged
    ? (process.resourcesPath ?? resolve(__dirname, '../../../..'))
    : resolve(__dirname, '../../../..');
  const devServerUrl = !app.isPackaged ? process.env['ELECTRON_RENDERER_URL'] : undefined;
  const rendererFile = join(__dirname, '../renderer/index.html');
  const rendererUrl = devServerUrl ?? pathToFileURL(rendererFile).href;
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: 'Donkey Car Simulator',
    show: false,
    backgroundColor: '#10171e',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  window.webContents.on('will-prevent-unload', (event) => {
    const discard = dialog.showMessageBoxSync(window, {
      type: 'question',
      title: 'Unsaved firmware',
      message: 'Discard unsaved changes?',
      detail: 'Your changes in the editor have not been saved to the car project.',
      buttons: ['Keep editing', 'Discard changes'],
      defaultId: 0,
      cancelId: 0,
    });
    // In Electron this allows the unload that the renderer prevented.
    if (discard === 1) event.preventDefault();
  });
  // Part datasheet links open in the system browser; nothing opens in the app.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  const project = new ProjectService({
    templateDir: app.isPackaged
      ? join(root, 'firmware-template')
      : join(root, 'packages/firmware-template'),
    recentFile: join(app.getPath('userData'), 'recent-projects.json'),
    pickFolder: async () => {
      const result = await dialog.showOpenDialog(window, {
        title: 'Open car project',
        properties: ['openDirectory'],
      });
      return result.canceled ? null : (result.filePaths[0] ?? null);
    },
  });
  const catalog = new CatalogService(project);
  const build = new BuildService(
    project,
    ((!app.isPackaged ? process.env['RCSIM_BUILD_SIM'] : undefined) ?? app.isPackaged)
      ? join(root, 'hal', 'bin', 'build-sim')
      : join(root, 'packages/hal/bin/build-sim'),
  );
  const pty = new PtyService(project);
  const run = new SimService({
    project,
    build,
    catalog,
    spawnHost: () => spawnUtilityHost(join(__dirname, 'sim-host.js')),
  });
  const control = new ControlService({ onRunStatus: run.onStatus });
  const worldEdit = new WorldEditService({ project, sim: run });
  const removeIpc = registerIpc(
    window,
    { project, catalog, build, pty, run, control, worldEdit },
    rendererUrl,
  );
  const stopRun = (): void => {
    run.dispose();
    control.reset();
  };
  const removeLifecycle = disposeRendererResources(window.webContents, [
    build,
    pty,
    { dispose: stopRun },
  ]);
  app.on('before-quit', stopRun);
  window.on('closed', () => {
    removeIpc();
    removeLifecycle();
    app.off('before-quit', stopRun);
    run.dispose();
    control.dispose();
    build.dispose();
    pty.dispose();
    catalog.dispose();
    void project.dispose();
  });
  // These accelerators invoke the same visible controls (including unsaved-file
  // guards) as the toolbar. No additional privileged renderer API is needed.
  const click = (action: string): void => {
    const invoke = (target: BrowserWindow): void => {
      void target.webContents
        .executeJavaScript(`document.querySelector('[data-action="${action}"]')?.click()`)
        .catch((error: unknown) => console.error('Could not invoke menu action:', error));
    };
    if (window.isDestroyed()) {
      const reopened = createWindow();
      reopened.once('ready-to-show', () => invoke(reopened));
    } else invoke(window);
  };
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      ...(process.platform === 'darwin' ? [{ role: 'appMenu' as const }] : []),
      {
        label: 'File',
        submenu: [
          {
            label: 'New Car Project…',
            accelerator: 'CmdOrCtrl+N',
            click: () => click('new-project'),
          },
          {
            label: 'Open Car Project…',
            accelerator: 'CmdOrCtrl+O',
            click: () => click('open-project'),
          },
          { label: 'Save', accelerator: 'CmdOrCtrl+S', click: () => click('save-file') },
          { type: 'separator' },
          { role: process.platform === 'darwin' ? 'close' : 'quit' },
        ],
      },
      { role: 'editMenu' },
      {
        label: 'Build',
        submenu: [
          { label: 'Build for Sim', accelerator: 'CmdOrCtrl+Shift+B', click: () => click('build') },
        ],
      },
      { role: 'viewMenu' },
      { role: 'windowMenu' },
    ]),
  );
  window.once('ready-to-show', () => window.show());
  if (devServerUrl) void window.loadURL(devServerUrl);
  else void window.loadFile(rendererFile);
  return window;
}
void app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) =>
    callback(false),
  );
  const compiler = checkCompiler();
  if (!compiler.ok) {
    dialog.showErrorBox('C++ compiler required', compiler.message ?? 'No usable compiler found.');
  }
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
