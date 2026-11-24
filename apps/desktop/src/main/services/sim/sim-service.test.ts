import { defaultCatalog, exampleCar, type Car, type World } from '@rcsim/schema';
import { createScriptedSource, type ActuatorSource } from '@rcsim/sim-core';
import type { NetFaults } from '@rcsim/sim-protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BuildEvent, RunInfo, WorldEditApi } from '../../../shared/ipc.ts';
import { Signal } from '../events.ts';
import { WorldEditService } from '../world-edit/world-edit-service.ts';
import type { HostChannel, HostEvent } from './host-protocol.ts';
import { SimHost } from './sim-host.ts';
import { SimService } from './sim-service.ts';

const world: World = { schemaVersion: 1, name: 'Oval', trackId: 'oval', seed: 1, obstacles: [] };

function fixture({
  car = exampleCar,
  ok = true,
  createSource,
}: {
  car?: Car;
  ok?: boolean;
  createSource?: () => ActuatorSource;
} = {}) {
  const events = new Signal<[HostEvent]>();
  const host = new SimHost((event) => events.emit(event), {
    createSource: createSource ?? (() => createScriptedSource([])),
  });
  const commands: string[] = [];
  const channel: HostChannel = {
    send(command) {
      commands.push(command.type);
      const { requestId } = command;
      void host.handle(command).then(
        (value) => events.emit({ type: 'reply', requestId, ok: true, value }),
        (error: Error) =>
          events.emit({ type: 'reply', requestId, ok: false, error: error.message }),
      );
    },
    onMessage: events.subscribe,
    onExit: () => () => {},
    kill: vi.fn(() => {
      void host.dispose();
    }),
  };
  const buildEvents = new Signal<[BuildEvent]>();
  const build = {
    onEvent: buildEvents.subscribe,
    start: vi.fn(async () => {
      expect(commands).toContain('header');
      buildEvents.emit({
        kind: 'done',
        buildId: 'id',
        ok,
        exitCode: ok ? 0 : 1,
        durationMs: 1,
        diagnostics: [],
      });
      return { buildId: 'id' };
    }),
    cancel: vi.fn(async () => {}),
  };
  const project = {
    requireProject: () => ({ dir: '/project', name: car.name }),
    readCar: async () => ({ ok: true as const, car }),
    readFile: async () => JSON.stringify(world),
    writeFile: vi.fn(async () => {
      commands.push('header');
    }),
    resolvePath: async () => '/project/.rcsim/build/firmware',
    listFiles: async () => [
      { path: 'worlds/z.json', kind: 'file' as const },
      { path: 'outside.json', kind: 'file' as const },
      { path: 'worlds/a.json', kind: 'file' as const },
    ],
  };
  const sim = new SimService({
    project,
    catalog: {
      list: async () => ({ builtIn: [...defaultCatalog.values()], custom: [], problems: [] }),
    },
    build,
    spawnHost: () => channel,
  });
  return { sim, channel, project, build, commands };
}

describe('desktop simulation services', () => {
  let sim: SimService | undefined;
  afterEach(() => {
    sim?.dispose();
    sim = undefined;
  });

  it('rejects wiring errors before building and reports failed builds without starting a host', async () => {
    const invalid = fixture({
      car: {
        ...exampleCar,
        parts: exampleCar.parts.map((part, index) =>
          index === 0 ? { ...part, partId: 'controller.missing' } : part,
        ),
      },
    });
    sim = invalid.sim;
    await expect(sim.start({ world, seed: 1 })).rejects.toThrow('[rcsim:wiring-errors]');
    expect(invalid.build.start).not.toHaveBeenCalled();
    expect(invalid.commands).toEqual([]);

    const failed = fixture({ ok: false });
    sim = failed.sim;
    await expect(sim.start({ world, seed: 1 })).rejects.toThrow('[rcsim:build-failed]');
    expect(failed.commands).toEqual(['header']);
    expect((await sim.info())?.state).toBe('ended');
  });

  it('runs, pauses, steps and edits the live layout through the host', async () => {
    const f = fixture();
    sim = f.sim;
    const statuses: RunInfo[] = [];
    const ticks: number[] = [];
    sim.onStatus((info) => statuses.push(info));
    sim.onSnapshot((snapshot) => ticks.push(snapshot.tick));

    const worldEdit: WorldEditApi = new WorldEditService({ project: f.project, sim });
    await expect(worldEdit.currentLayout()).rejects.toThrow('[rcsim:no-run]');
    const starting = sim.start({ world, seed: 1, speed: 2 });
    await expect(sim.start({ world, seed: 1 })).rejects.toThrow('[rcsim:busy]');
    await expect(starting).resolves.toMatchObject({ state: 'running', speed: 2 });
    await expect.poll(() => ticks.at(-1) ?? 0).toBeGreaterThan(0);
    await expect(sim.step()).rejects.toThrow('[rcsim:busy]');
    await expect(worldEdit.currentLayout()).rejects.toThrow('[rcsim:busy]');

    await sim.pause();
    const pausedAt = ticks.at(-1) ?? 0;
    await sim.step(5);
    expect(ticks.at(-1)).toBe(pausedAt + 5);

    const id = await worldEdit.addObstacle({ type: 'cone', positionM: { x: 1, z: 1 }, yawDeg: 0 });
    await worldEdit.moveObstacle(id, { x: 2, z: 1 }, 15);
    await sim.resume();
    await sim.pause();
    const layout = await worldEdit.currentLayout();
    expect(layout.obstacles[0]).toMatchObject({ id, positionM: { x: 2, z: 1 } });
    expect(layout.obstacles[0]?.yawDeg).toBeCloseTo(15, 5);
    await worldEdit.removeObstacle(id);
    expect((await worldEdit.currentLayout()).obstacles).toEqual([]);

    await sim.stop();
    expect(statuses.at(-1)).toMatchObject({ state: 'ended', end: { kind: 'stopped' } });
    await expect(
      sim.start({ world: 'worlds/a.json', seed: 1, paused: true }),
    ).resolves.toMatchObject({ state: 'paused' });
    sim.dispose();
    expect(f.channel.kill).toHaveBeenCalledOnce();
  });

  it('validates track names, layout paths and world files before writing', async () => {
    const f = fixture();
    sim = f.sim;
    const service = new WorldEditService({ project: f.project, sim });
    await expect(service.listTracks()).resolves.toEqual(['oval', 'technical']);
    await expect(service.loadTrack('nope')).rejects.toThrow('[rcsim:not-found]');
    await expect(service.listLayouts()).resolves.toEqual(['worlds/a.json', 'worlds/z.json']);
    await expect(service.save('worlds/../outside.json', world)).rejects.toThrow('[rcsim:invalid]');
    await expect(service.save('outside.json', world)).rejects.toThrow('[rcsim:invalid]');
    await expect(service.save('worlds/new.json', { ...world, name: '' })).rejects.toThrow(
      '[rcsim:invalid]',
    );
    expect(f.project.writeFile).not.toHaveBeenCalled();
    await service.save('worlds/new.json', world);
    expect(f.project.writeFile).toHaveBeenCalledWith(
      'worlds/new.json',
      expect.stringContaining('"seed": 1'),
      'worlds',
    );
  });

  it('validates setNetFaults at IPC, enforces run state, applies paused edits on next step, and supports reset', async () => {
    const receivedFaults: Array<NetFaults | undefined> = [];
    const source: ActuatorSource = {
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      step: vi.fn(async ({ netFaults }) => {
        receivedFaults.push(netFaults);
        return { pwm: [], gpioWrites: [], serialTx: new Uint8Array(), netEvents: [], logs: [] };
      }),
    };
    const f = fixture({ createSource: () => source });
    sim = f.sim;

    // Invalid payloads are rejected with [rcsim:invalid] before checking run state.
    const invalidCases: unknown[] = [
      null,
      undefined,
      [],
      'bad',
      { latencyUs: -1, lossPpm: 0, dropout: false },
      { latencyUs: 1.5, lossPpm: 0, dropout: false },
      { latencyUs: Number.NaN, lossPpm: 0, dropout: false },
      { latencyUs: Number.POSITIVE_INFINITY, lossPpm: 0, dropout: false },
      { latencyUs: 0x1_0000_0000, lossPpm: 0, dropout: false },
      { latencyUs: '100', lossPpm: 0, dropout: false },
      { latencyUs: 0, lossPpm: -1, dropout: false },
      { latencyUs: 0, lossPpm: 0.5, dropout: false },
      { latencyUs: 0, lossPpm: Number.NaN, dropout: false },
      { latencyUs: 0, lossPpm: 1_000_001, dropout: false },
      { latencyUs: 0, lossPpm: '100', dropout: false },
      { latencyUs: 0, lossPpm: 0, dropout: 'true' },
      { latencyUs: 0, lossPpm: 0, dropout: 1 },
      { latencyUs: 0, lossPpm: 0 },
    ];
    for (const bad of invalidCases) {
      await expect(sim.setNetFaults(bad as NetFaults)).rejects.toThrow('[rcsim:invalid]');
    }
    expect(f.commands).toEqual([]);

    // Valid payload without an active run fails with [rcsim:no-run].
    await expect(sim.setNetFaults({ latencyUs: 1000, lossPpm: 0, dropout: false })).rejects.toThrow(
      '[rcsim:no-run]',
    );

    // Starting run rejects with [rcsim:busy] until active.
    const starting = sim.start({ world, seed: 1, paused: true });
    await expect(sim.setNetFaults({ latencyUs: 1000, lossPpm: 0, dropout: false })).rejects.toThrow(
      '[rcsim:busy]',
    );
    await expect(starting).resolves.toMatchObject({ state: 'paused' });

    // Edit while paused does not step, and takes effect on the next step.
    await sim.setNetFaults({ latencyUs: 25_000, lossPpm: 125_000, dropout: true });
    expect(source.step).not.toHaveBeenCalled();

    await sim.step(1);
    expect(receivedFaults).toEqual([{ latencyUs: 25_000, lossPpm: 125_000, dropout: true }]);

    // Subsequent step sends no netFaults when unchanged.
    await sim.step(1);
    expect(receivedFaults).toEqual([
      { latencyUs: 25_000, lossPpm: 125_000, dropout: true },
      undefined,
    ]);

    // Reset (including -0 normalization) applies on the next step.
    await sim.setNetFaults({ latencyUs: -0, lossPpm: -0, dropout: false });
    await sim.step(1);
    expect(receivedFaults.at(-1)).toEqual({ latencyUs: 0, lossPpm: 0, dropout: false });
    expect(Object.is(receivedFaults.at(-1)?.latencyUs, 0)).toBe(true);
    expect(Object.is(receivedFaults.at(-1)?.lossPpm, 0)).toBe(true);

    // Boundary max values succeed while running.
    await sim.resume();
    await sim.setNetFaults({ latencyUs: 0xffff_ffff, lossPpm: 1_000_000, dropout: false });
    await expect.poll(() => receivedFaults.some((x) => x?.latencyUs === 0xffff_ffff)).toBe(true);

    // Stopped run rejects again with [rcsim:no-run].
    await sim.stop();
    await expect(sim.setNetFaults({ latencyUs: 0, lossPpm: 0, dropout: false })).rejects.toThrow(
      '[rcsim:no-run]',
    );
  });
});
