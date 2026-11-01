import { describe, expect, it } from 'vitest';
import { createFakeRcsimApi } from './fake-api.ts';
import {
  IPC_EVENTS,
  IPC_METHODS,
  ipcChannel,
  ipcErrorMessage,
  parseIpcError,
  type ServiceName,
} from './ipc.ts';

describe('IPC channel tables', () => {
  const { api } = createFakeRcsimApi();
  const services = Object.keys(IPC_METHODS) as ServiceName[];

  it.each(services)('%s lists exactly the members of its API', (service) => {
    const members = Object.keys(api[service]).sort();
    expect([...IPC_METHODS[service], ...IPC_EVENTS[service]].sort()).toEqual(members);
  });

  it('names channels <service>:<member>', () => {
    expect(ipcChannel('run', 'onSnapshot')).toBe('run:onSnapshot');
    const all = services.flatMap((s) =>
      [...IPC_METHODS[s], ...IPC_EVENTS[s]].map((m) => ipcChannel(s, m)),
    );
    expect(new Set(all).size).toBe(all.length);
  });
});

describe('IPC errors', () => {
  it('round-trip their code through an Error message', () => {
    const error = new Error(ipcErrorMessage('wiring-errors', 'GPIO 6 is a flash pin'));
    expect(parseIpcError(error)).toEqual({
      code: 'wiring-errors',
      message: 'GPIO 6 is a flash pin',
    });
    // Electron prefixes the message ("Error invoking remote method 'run:start': …").
    const wrapped = new Error(`Error invoking remote method 'run:start': Error: ${error.message}`);
    expect(parseIpcError(wrapped).code).toBe('wiring-errors');
    expect(parseIpcError(new Error('boom'))).toEqual({ code: 'unknown', message: 'boom' });
  });
});
