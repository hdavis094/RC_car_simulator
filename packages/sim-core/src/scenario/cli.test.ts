import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { exampleCar } from '@rcsim/schema';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ScenarioResult } from '../api/scenario.ts';
import { ARMED_BY_US, ESC_GPIO, NEUTRAL, throttlePulse } from '../run/test-support.ts';
import { main } from './cli.ts';
import { ScenarioInputError, runScenario } from './runner.ts';

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'rcsim-test-'));
  const write = (name: string, value: unknown): void =>
    writeFileSync(path.join(dir, name), JSON.stringify(value));
  write('car.json', exampleCar);
  write('world.json', {
    schemaVersion: 1,
    name: 'cli test',
    trackId: 'oval',
    seed: 11,
    start: { positionM: { x: 2.4, z: 0 }, yawDeg: 0 },
    obstacles: [{ id: 'cone-1', type: 'cone', positionM: { x: 2.4, z: -2 }, yawDeg: 0 }],
  });
  write('into-cone.json', [
    ...NEUTRAL,
    { tUs: ARMED_BY_US, gpio: ESC_GPIO, pulseUs: throttlePulse(0.3) },
  ]);
  write('idle.json', NEUTRAL);
  write('bad-script.json', [{ tUs: 'soon' }]);
  writeFileSync(path.join(dir, 'not-json.json'), '{');
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

async function rcsim(
  ...args: string[]
): Promise<{ code: number; out: string; err: string; result?: ScenarioResult }> {
  let out = '';
  let err = '';
  const code = await main(args, {
    cwd: dir,
    stdout: (t) => (out += t),
    stderr: (t) => (err += t),
  });
  return {
    code,
    out,
    err,
    ...(out.startsWith('{') ? { result: JSON.parse(out) as ScenarioResult } : {}),
  };
}

const base = ['run', '--car', 'car.json', '--world', 'world.json'];

describe('rcsim run', () => {
  it('prints the result as JSON and exits 0 when the assertions hold', async () => {
    const r = await rcsim(
      ...base,
      '--seconds',
      '2',
      '--script',
      'idle.json',
      '--assert',
      'collisions == 0',
      '--assert',
      'laps < 1',
      '--assert',
      'maxSpeed < 0.1',
    );
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    expect(r.result?.passed).toBe(true);
    expect(r.result?.assertions.map((a) => [a.metric, a.op, a.passed])).toEqual([
      ['collisions', '==', true],
      ['laps', '<', true],
      ['maxSpeedMps', '<', true],
    ]);
    expect(r.result?.metrics.simSeconds).toBe(2);
    expect(r.result?.end).toEqual({ kind: 'stopped' });
    expect(r.result?.snapshotHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('exits 1 when an assertion fails, and says which', async () => {
    const r = await rcsim(
      ...base,
      '--seconds',
      '9',
      '--script',
      'into-cone.json',
      '--assert',
      'collisions == 0',
      '--assert',
      'maxSpeed < 100',
    );
    expect(r.code).toBe(1);
    expect(r.result?.passed).toBe(false);
    expect(r.result?.metrics.collisions).toBe(1);
    expect(r.result?.assertions.map((a) => a.passed)).toEqual([false, true]);
    expect(r.result?.assertions[0]?.actual).toBe(1);
  });

  it('repeats exactly for the same seed (same hash), and uses the world seed by default', async () => {
    const args = [...base, '--seconds', '5', '--script', 'into-cone.json'];
    const a = await rcsim(...args, '--seed', '11');
    const b = await rcsim(...args);
    const c = await rcsim(...args, '--seed', '12');
    expect(a.result?.snapshotHash).toBe(b.result?.snapshotHash);
    expect(c.result?.metrics).toEqual(a.result?.metrics); // no randomness reaches the physics yet
  });

  it('exits 2 for bad arguments and bad inputs, with a message on stderr', async () => {
    const cases: [string[], RegExp][] = [
      [['run', '--world', 'world.json', '--seconds', '1'], /--car is required/],
      [[...base, '--seconds', 'soon', '--script', 'idle.json'], /--seconds must be/],
      [
        [...base, '--seconds', '1', '--script', 'idle.json', '--tick-us', '0'],
        /--tick-us must be a positive integer/,
      ],
      [[...base, '--seconds', '1', '--script', 'idle.json', '--tick-us', '-5'], /--tick-us/],
      [[...base, '--seconds', '1', '--script', 'idle.json', '--tick-us', '2.5'], /--tick-us/],
      [[...base, '--seconds', '1', '--script', 'idle.json', '--tick-us', ''], /--tick-us/],
      [[...base, '--seconds', '1'], /--script/],
      [
        [...base, '--seconds', '1', '--script', 'idle.json', '--assert', 'speeding == 1'],
        /bad assertion/,
      ],
      [[...base, '--seconds', '1', '--script', 'missing.json'], /cannot read script/],
      [[...base, '--seconds', '1', '--script', 'not-json.json'], /not JSON/],
      [[...base, '--seconds', '1', '--script', 'bad-script.json'], /script entry 0/],
      [
        [
          'run',
          '--car',
          'world.json',
          '--world',
          'world.json',
          '--seconds',
          '1',
          '--script',
          'idle.json',
        ],
        /invalid car/,
      ],
      [[...base, '--seconds', '1', '--firmware', 'fw'], /firmware bridge/],
      [['fly'], /unknown command/],
      [['run', '--bogus'], /bogus/],
    ];
    for (const [args, message] of cases) {
      const r = await rcsim(...args);
      expect(r.code, args.join(' ')).toBe(2);
      expect(r.err, args.join(' ')).toMatch(message);
      expect(r.out).toBe('');
    }
  });

  it('prints usage for --help and for no arguments', async () => {
    expect((await rcsim('--help')).code).toBe(0);
    expect((await rcsim('--help')).out).toMatch(/usage: rcsim run/);
    expect((await rcsim()).code).toBe(2);
  });
});

describe('runScenario', () => {
  it('rejects a tick length that is not a positive whole number of microseconds', async () => {
    for (const tickUs of [0, -1, 1.5, Number.NaN]) {
      await expect(
        runScenario(
          {
            car: 'car.json',
            world: 'world.json',
            seconds: 1,
            seed: 1,
            tickUs,
            script: 'idle.json',
            assertions: [],
          },
          { cwd: dir },
        ),
      ).rejects.toBeInstanceOf(ScenarioInputError);
    }
  });
});

describe('the rcsim executable', () => {
  const bin = fileURLToPath(new URL('./bin.ts', import.meta.url));

  it('runs 60 s of sim time at 1 ms ticks in under 10 s of wall time, exit code 0', () => {
    const started = performance.now();
    const r = spawnSync(
      process.execPath,
      [
        bin,
        ...base,
        '--seconds',
        '60',
        '--seed',
        '1',
        '--script',
        'into-cone.json',
        '--assert',
        'collisions <= 1',
      ],
      { cwd: dir, encoding: 'utf8' },
    );
    const wallS = (performance.now() - started) / 1000;
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).metrics.simSeconds).toBe(60);
    expect(wallS).toBeLessThan(10);
  }, 30_000);

  it('exits non-zero for a failed assertion', () => {
    const r = spawnSync(
      process.execPath,
      [bin, ...base, '--seconds', '9', '--script', 'into-cone.json', '--assert', 'collisions == 0'],
      { cwd: dir, encoding: 'utf8' },
    );
    expect(r.status).toBe(1);
    expect(JSON.parse(r.stdout).passed).toBe(false);
  }, 30_000);
});
