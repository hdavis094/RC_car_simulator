import { contextBridge, ipcRenderer } from 'electron';
import {
  IPC_EVENTS,
  IPC_METHODS,
  ipcChannel,
  type RcsimApi,
  type ServiceName,
} from '../shared/ipc.ts';

// Only the contract's allowlisted methods and subscriptions cross the bridge.
// ipcRenderer and the privileged Electron event are never exposed.
const api: Record<string, unknown> = {
  platform: process.platform === 'darwin' ? 'darwin' : 'linux',
};
for (const service of Object.keys(IPC_METHODS) as ServiceName[]) {
  const members: Record<string, unknown> = {};
  for (const method of IPC_METHODS[service]) {
    members[method] = (...args: unknown[]) =>
      ipcRenderer.invoke(ipcChannel(service, method), ...args);
  }
  for (const event of IPC_EVENTS[service]) {
    members[event] = (listener: (...args: unknown[]) => void) => {
      const channel = ipcChannel(service, event);
      const handler = (_event: Electron.IpcRendererEvent, ...args: unknown[]): void =>
        listener(...args);
      ipcRenderer.on(channel, handler);
      return () => ipcRenderer.removeListener(channel, handler);
    };
  }
  api[service] = members;
}
contextBridge.exposeInMainWorld('rcsim', api as unknown as RcsimApi);
