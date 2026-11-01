import { defaultCatalog, exampleCar, generateCarConfigHeader } from '@rcsim/schema';
import { describe, expect, it } from 'vitest';
import { createFakeRcsimApi } from './fake-api.ts';
import {
  IPC_EVENTS,
  IPC_METHODS,
  ipcChannel,
  ipcErrorMessage,
  parseIpcError,
  type BuildEvent,
  type RunInfo,
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

describe('the fake API', () => {
  it('reads the example car and writes car.json with a byte-identical header', async () => {
    const fake = createFakeRcsimApi();
    const read = await fake.api.project.readCar();
    expect(read.ok && read.car).toEqual(exampleCar);
    await fake.api.project.writeCar(exampleCar);
    expect(fake.files.get('include/car_config.h')).toBe(
      generateCarConfigHeader(exampleCar, defaultCatalog),
    );
  });

  it('saves a custom part and lists it, rejecting an invalid one with a code', async () => {
    const fake = createFakeRcsimApi();
    const servo = (await fake.api.catalog.list()).builtIn.find((p) => p.id === 'actuator.mg996r');
    if (!servo) throw new Error('no servo');
    const changes: number[] = [];
    fake.api.catalog.onChange((listing) => changes.push(listing.custom.length));
    const { path } = await fake.api.catalog.saveCustomPart({
      ...servo,
      id: 'custom.servo',
      name: 'My servo',
    });
    expect(path).toBe('parts/custom.servo.json');
    expect((await fake.api.catalog.list()).custom.map((c) => c.definition.id)).toEqual([
      'custom.servo',
    ]);
    expect(changes).toEqual([1]);
    await expect(fake.api.catalog.saveCustomPart({ ...servo, massG: -1 })).rejects.toThrow(
      '[rcsim:invalid]',
    );
  });

  it('streams build output and structured diagnostics', async () => {
    const fake = createFakeRcsimApi({
      buildDiagnostics: [
        { file: 'src/main.cpp', line: 3, column: 5, severity: 'error', message: "expected ';'" },
      ],
    });
    const events: BuildEvent[] = [];
    fake.api.build.onEvent((e) => events.push(e));
    await fake.api.build.start('sim');
    await Promise.resolve();
    expect(events.map((e) => e.kind)).toEqual(['output', 'done']);
    expect(events[1]).toMatchObject({ ok: false, diagnostics: [{ line: 3, column: 5 }] });
  });

  it('runs, pauses, edits the live world and reports status', async () => {
    const fake = createFakeRcsimApi({
      files: {
        'worlds/cones.json': JSON.stringify({
          schemaVersion: 1,
          name: 'Cones',
          trackId: 'oval',
          seed: 1,
          obstacles: [],
        }),
      },
    });
    const statuses: RunInfo['state'][] = [];
    fake.api.run.onStatus((info) => statuses.push(info.state));
    const info = await fake.api.run.start({ world: 'worlds/cones.json', seed: 1 });
    expect(info.netMappings[0]?.firmwarePort).toBe(3333);
    await fake.api.run.pause();
    const id = await fake.api.worldEdit.addObstacle({
      type: 'cone',
      positionM: { x: 1, z: -2 },
      yawDeg: 0,
    });
    await fake.api.worldEdit.moveObstacle(id, { x: 1.5, z: -2 }, 30);
    expect((await fake.api.worldEdit.currentLayout()).obstacles).toEqual([
      { id, type: 'cone', positionM: { x: 1.5, z: -2 }, yawDeg: 30 },
    ]);
    await fake.api.run.stop();
    expect(statuses).toEqual(['running', 'paused', 'ended']);
  });

  it('records control commands and refuses them while disconnected', async () => {
    const fake = createFakeRcsimApi();
    expect(await fake.api.control.drive({ throttle: 0.5, steer: 0 })).toBe(false);
    await fake.api.control.connect({ kind: 'run' });
    expect(await fake.api.control.drive({ throttle: 0.5, steer: -0.2 })).toBe(true);
    expect(fake.calls.filter((c) => c.service === 'control').map((c) => c.method)).toEqual([
      'drive',
      'connect',
      'drive',
    ]);
  });
});
