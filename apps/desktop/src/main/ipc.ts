import { ipcMain, type BrowserWindow } from 'electron';
import {
  IPC_EVENTS,
  IPC_METHODS,
  ipcChannel,
  type RcsimApi,
  type ServiceName,
} from '../shared/ipc.ts';
import { errorText, fail } from './services/errors.ts';

export type MainServices = Pick<RcsimApi, 'project' | 'catalog' | 'build' | 'pty'>;

function isAppUrl(url: string, rendererUrl: string): boolean {
  try {
    const sender = new URL(url);
    const trusted = new URL(rendererUrl);
    if (trusted.protocol === 'http:' || trusted.protocol === 'https:')
      return sender.origin === trusted.origin;
    if (trusted.protocol !== 'file:') return false;
    // file: URLs all have a null origin. Trust only our actual entry document.
    sender.hash = '';
    trusted.hash = '';
    return sender.href === trusted.href;
  } catch {
    return false;
  }
}

export function registerIpc(
  window: BrowserWindow,
  services: MainServices,
  rendererUrl: string,
): () => void {
  const disposers: (() => void)[] = [];
  for (const service of Object.keys(IPC_METHODS) as ServiceName[]) {
    const implementation =
      service in services ? services[service as keyof MainServices] : undefined;
    const members = implementation as unknown as
      Record<string, (...args: unknown[]) => unknown> | undefined;
    for (const method of IPC_METHODS[service]) {
      const channel = ipcChannel(service, method);
      ipcMain.handle(channel, async (event, ...args: unknown[]) => {
        if (
          event.sender !== window.webContents ||
          event.senderFrame !== window.webContents.mainFrame ||
          !isAppUrl(event.senderFrame?.url ?? '', rendererUrl)
        )
          fail('invalid', 'Untrusted IPC sender.');
        if (!members)
          fail('not-implemented', `${service}.${method} is not implemented yet (P2-01).`);
        try {
          return await members[method]?.apply(implementation, args);
        } catch (error) {
          const message = errorText(error);
          if (message.includes('[rcsim:')) throw error;
          const code =
            typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
          fail(code === 'ENOENT' ? 'not-found' : 'io', message);
        }
      });
      disposers.push(() => ipcMain.removeHandler(channel));
    }
    for (const event of IPC_EVENTS[service]) {
      if (!members) continue;
      const subscribe = members[event];
      if (!subscribe) continue;
      const unsubscribe = subscribe.call(implementation, (...args: unknown[]) => {
        if (!window.isDestroyed()) window.webContents.send(ipcChannel(service, event), ...args);
      }) as () => void;
      disposers.push(unsubscribe);
    }
  }
  return () => {
    for (const dispose of disposers) dispose();
  };
}
