import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';
import { createFakeRcsimApi } from '../shared/fake-api.ts';
import { parseIpcError } from '../shared/ipc.ts';
import { ProjectService } from './services/project.ts';
import { registerIpc } from './ipc.ts';

const { handlers } = vi.hoisted(() => ({
  handlers: new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>>(),
}));
vi.mock('electron', () => ({
  ipcMain: {
    handle: (
      channel: string,
      handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>,
    ) => handlers.set(channel, handler),
    removeHandler: (channel: string) => handlers.delete(channel),
  },
}));

const rendererUrl = 'file:///app/renderer/index.html';
describe('IPC registration', () => {
  let dir: string;
  let project: ProjectService;
  let remove: () => void;
  let window: BrowserWindow;
  let event: IpcMainInvokeEvent;
  let frame: { url: string };
  let fake: ReturnType<typeof createFakeRcsimApi>;
  beforeEach(async () => {
    dir = await realpath(await mkdtemp(join(tmpdir(), 'rcsim-ipc-')));
    project = new ProjectService({
      templateDir: '',
      recentFile: join(dir, 'recent.json'),
      pickFolder: async () => null,
    });
    await project.open(dir);
    frame = { url: rendererUrl };
    const webContents = { mainFrame: frame, send: vi.fn() };
    window = { webContents, isDestroyed: () => false } as unknown as BrowserWindow;
    event = { sender: webContents, senderFrame: frame } as unknown as IpcMainInvokeEvent;
    fake = createFakeRcsimApi();
    const { api } = fake;
    remove = registerIpc(
      window,
      { project, catalog: api.catalog, build: api.build, pty: api.pty },
      rendererUrl,
    );
  });
  afterEach(async () => {
    remove();
    handlers.clear();
    await project.dispose();
    await rm(dir, { recursive: true, force: true });
  });
  const invoke = (channel: string, event: IpcMainInvokeEvent, ...args: unknown[]) =>
    handlers.get(channel)!(event, ...args);

  it('wraps a real missing-file error as not-found and preserves existing IPC codes', async () => {
    await expect(invoke('project:readFile', event, 'missing.cpp')).rejects.toThrow(
      '[rcsim:not-found]',
    );
    await expect(invoke('project:writeFile', event, '../escape', 'text')).rejects.toThrow(
      '[rcsim:invalid]',
    );
    await expect(invoke('run:info', event)).rejects.toThrow('[rcsim:not-implemented]');
  });
  it('wraps other filesystem failures as io', async () => {
    await expect(invoke('project:readFile', event, 'recent.json/child')).rejects.toThrow(
      '[rcsim:io]',
    );
  });
  it('rejects another sender and subframes before invoking a service', async () => {
    await expect(
      invoke('project:current', { ...event, sender: {} } as IpcMainInvokeEvent),
    ).rejects.toThrow('[rcsim:invalid]');
    await expect(
      invoke('project:current', {
        ...event,
        senderFrame: { url: rendererUrl },
      } as IpcMainInvokeEvent),
    ).rejects.toThrow('[rcsim:invalid]');
  });
  it.each(['https://example.com', 'file:///tmp/untrusted.html', 'about:blank', 'invalid-url'])(
    'rejects a main frame at %s',
    async (url) => {
      frame.url = url;
      await expect(invoke('project:current', event)).rejects.toThrow('[rcsim:invalid]');
    },
  );
  it('allows the app document with an anchor and rejects a changed file URL query', async () => {
    frame.url = `${rendererUrl}#terminal`;
    await expect(invoke('project:current', event)).resolves.toMatchObject({ dir });
    frame.url = `${rendererUrl}?other`;
    await expect(invoke('project:current', event)).rejects.toThrow('[rcsim:invalid]');
  });
  it('allows only the configured dev server origin', async () => {
    remove();
    const { api } = createFakeRcsimApi();
    remove = registerIpc(
      window,
      { project, catalog: api.catalog, build: api.build, pty: api.pty },
      'http://localhost:5173',
    );
    frame.url = 'http://localhost:5173/terminal';
    await expect(invoke('project:current', event)).resolves.toMatchObject({ dir });
    frame.url = 'http://localhost:5174/terminal';
    await expect(invoke('project:current', event)).rejects.toThrow('[rcsim:invalid]');
  });
  it('forwards event data and removes handlers/subscriptions when disposed', async () => {
    await fake.api.build.start('sim');
    expect(window.webContents.send).toHaveBeenCalledWith(
      'build:onEvent',
      expect.objectContaining({ kind: 'done', ok: true }),
    );
    vi.mocked(window.webContents.send).mockClear();
    remove();
    expect(handlers.size).toBe(0);
    await fake.api.build.start('sim');
    expect(window.webContents.send).not.toHaveBeenCalled();
  });
  it('exposes useful structured errors to the renderer', async () => {
    const error = await invoke('project:readFile', event, 'missing').catch(
      (error: unknown) => error,
    );
    expect(parseIpcError(error)).toMatchObject({
      code: 'not-found',
      message: expect.stringContaining('missing'),
    });
  });
});
