import { defaultCatalog, exampleCar, generateCarConfigHeader } from '@rcsim/schema';
import { describe, expect, it } from 'vitest';
import { createFakeRcsimApi } from './fake-api.ts';
import type { BuildEvent, RunInfo } from './ipc.ts';

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

  it('lists a broken custom part file as a problem, keeping the rest', async () => {
    const fake = createFakeRcsimApi();
    fake.files.set('parts/broken.json', '{');
    const listing = await fake.api.catalog.list();
    expect(listing.problems.map((p) => p.source)).toEqual(['parts/broken.json']);
    expect(listing.builtIn.length).toBeGreaterThan(0);
    await fake.api.project.writeCar(exampleCar);
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
    // Live edits and single steps need the run paused, as in main.
    await expect(
      fake.api.worldEdit.addObstacle({ type: 'cone', positionM: { x: 0, z: 0 }, yawDeg: 0 }),
    ).rejects.toThrow('[rcsim:busy]');
    await expect(fake.api.run.step()).rejects.toThrow('[rcsim:busy]');
    await fake.api.run.pause();
    await fake.api.run.step(5);
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

  it("serves built-in tracks and names the run's track", async () => {
    const fake = createFakeRcsimApi({
      files: {
        'worlds/a.json': JSON.stringify({
          schemaVersion: 1,
          name: 'A',
          trackId: 'oval',
          seed: 1,
          obstacles: [],
        }),
      },
    });
    expect(await fake.api.worldEdit.listTracks()).toEqual(['oval']);
    expect((await fake.api.worldEdit.loadTrack('oval')).id).toBe('oval');
    await expect(fake.api.worldEdit.loadTrack('moon')).rejects.toThrow('[rcsim:not-found]');
    expect((await fake.api.run.start({ world: 'worlds/a.json', seed: 1 })).trackId).toBe('oval');
  });

  it('clones results, clears the layout on stop and keeps obstacle ids unique', async () => {
    const fake = createFakeRcsimApi();
    await fake.api.run.start({
      world: { schemaVersion: 1, name: 'W', trackId: 'oval', seed: 1, obstacles: [] },
      seed: 1,
      paused: true,
    });
    const id = await fake.api.worldEdit.addObstacle({
      type: 'cone',
      positionM: { x: 0, z: -1 },
      yawDeg: 0,
    });
    await expect(
      fake.api.worldEdit.addObstacle({ id, type: 'box', positionM: { x: 1, z: -1 }, yawDeg: 0 }),
    ).rejects.toThrow('[rcsim:invalid]');
    const layout = await fake.api.worldEdit.currentLayout();
    layout.obstacles.length = 0; // mutating a result…
    expect((await fake.api.worldEdit.currentLayout()).obstacles).toHaveLength(1); // …changes nothing
    await fake.api.run.stop();
    await expect(fake.api.worldEdit.currentLayout()).rejects.toThrow('[rcsim:no-run]');
  });

  it('rejects a custom part that reuses a built-in id', async () => {
    const fake = createFakeRcsimApi();
    const servo = (await fake.api.catalog.list()).builtIn.find((p) => p.id === 'actuator.mg996r');
    if (!servo) throw new Error('no servo');
    await expect(fake.api.catalog.saveCustomPart(servo)).rejects.toThrow('[rcsim:invalid]');
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
