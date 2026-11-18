import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { exampleCar } from '@rcsim/schema';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ScenarioSpec } from '../api/scenario.ts';
import { buildSketch, removeProject } from '../bridge/test-support.ts';
import { NEUTRAL } from '../run/test-support.ts';
import { runScenario } from './runner.ts';

const SHA256_OF_NOTHING = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

let dir: string;
let project: string;
let binary: string;
beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'rcsim-runner-'));
  const write = (name: string, value: unknown): void =>
    writeFileSync(path.join(dir, name), JSON.stringify(value));
  write('car.json', exampleCar);
  write('world.json', {
    schemaVersion: 1,
    name: 'runner test',
    trackId: 'oval',
    seed: 11,
    start: { positionM: { x: 2.4, z: 0 }, yawDeg: 0 },
    obstacles: [],
  });
  write('idle.json', NEUTRAL);
  ({ binary, project } = await buildSketch('ticker'));
}, 120_000);
afterAll(async () => {
  rmSync(dir, { recursive: true, force: true });
  await removeProject(project);
});

const spec = (over: Partial<ScenarioSpec>): ScenarioSpec => ({
  car: 'car.json',
  world: 'world.json',
  seed: 1,
  seconds: 3,
  assertions: [],
  ...over,
});

describe('runScenario serialHash', () => {
  it('is the SHA-256 of zero bytes for a scripted scenario', async () => {
    const r = await runScenario(spec({ script: 'idle.json' }), { cwd: dir });
    expect(r.serialHash).toBe(SHA256_OF_NOTHING);
  });

  it('is equal across runs of the same firmware and seed', async () => {
    const a = await runScenario(spec({ firmware: binary }), { cwd: dir });
    const b = await runScenario(spec({ firmware: binary }), { cwd: dir });
    expect(a.serialHash).toMatch(/^[0-9a-f]{64}$/);
    expect(a.serialHash).not.toBe(SHA256_OF_NOTHING);
    expect(b.serialHash).toBe(a.serialHash);
  }, 60_000);

  it('differs when the firmware prints different text', async () => {
    const short = await runScenario(spec({ firmware: binary, seconds: 2 }), { cwd: dir });
    const long = await runScenario(spec({ firmware: binary, seconds: 3 }), { cwd: dir });
    expect(long.serialHash).not.toBe(short.serialHash);
  }, 60_000);
});
