import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { defaultCatalog, exampleCar } from '@rcsim/schema';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createRun } from '../run/run.ts';
import { testWorldFile } from '../run/test-support.ts';
import { main } from '../scenario/cli.ts';
import { trackLibrary } from '../world/track-library.ts';
import { ControlScriptError, parseControlScript, withControlScript } from './control-script.ts';
import { createFirmwareSource } from './firmware-source.ts';
import { buildSketch, capture, removeProject } from './test-support.ts';

// Waits in these tests are wall-clock and CI is slow: no test may time out before the longest wait it allows.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 300_000 });

describe('parseControlScript', () => {
  const drive = { t: 'drive', seq: 1, throttle: 0.3, steer: 0 };

  it('turns messages into lines, in time order, defaulting to the control port', () => {
    const entries = parseControlScript([
      { tUs: 2_000_000, message: { t: 'estop' } },
      { tUs: 1_000_000, message: drive },
      { tUs: 1_500_000, port: 4000, line: 'junk' },
    ]);
    expect(entries).toEqual([
      { tUs: 1_000_000, port: 3333, line: JSON.stringify(drive) },
      { tUs: 1_500_000, port: 4000, line: 'junk' },
      { tUs: 2_000_000, port: 3333, line: '{"t":"estop"}' },
    ]);
  });

  it('repeats an entry and counts a drive’s seq up', () => {
    const entries = parseControlScript([
      { tUs: 0, message: drive, everyMs: 100, untilUs: 250_000 },
    ]);
    expect(entries.map((e) => e.tUs)).toEqual([0, 100_000, 200_000]);
    expect(entries.map((e) => (JSON.parse(e.line) as { seq: number }).seq)).toEqual([1, 2, 3]);
  });

  it('rejects what it cannot send', () => {
    const bad: [unknown, RegExp][] = [
      [{}, /JSON array/],
      [[1], /entry 0 must be an object/],
      [[{ message: drive }], /"tUs" must be a number/],
      [[{ tUs: 0 }], /exactly one of/],
      [[{ tUs: 0, message: drive, line: 'x' }], /exactly one of/],
      [[{ tUs: 0, message: { t: 'drive', seq: 'x' } }], /not a control-protocol client message/],
      [[{ tUs: 0, message: { t: 'hello', name: 'a', fw: 'b', proto: 1 } }], /client message/],
      [[{ tUs: 0, line: 'a\nb' }], /without a newline/],
      [[{ tUs: 0, line: 'x', port: 0 }], /"port"/],
      [[{ tUs: 0, line: 'x', everyMs: 100 }], /go together/],
      [[{ tUs: 0, line: 'x'.repeat(5000) }], /longer than 4096/],
    ];
    for (const [value, message] of bad) {
      expect(() => parseControlScript(value), JSON.stringify(value)).toThrow(ControlScriptError);
      expect(() => parseControlScript(value), JSON.stringify(value)).toThrow(message);
    }
  });
});

describe('playing a control timeline into a firmware', () => {
  let binary = '';
  let project = '';
  let dir = '';
  beforeAll(async () => {
    ({ binary, project } = await buildSketch('control'));
    dir = await mkdtemp(path.join(tmpdir(), 'rcsim-control-test-'));
  }, 120_000);
  afterAll(async () => {
    await removeProject(project);
    await rm(dir, { recursive: true, force: true });
  });

  const timeline = [
    { tUs: 500_000, message: { t: 'mode', mode: 'manual' } },
    { tUs: 1_000_000, message: { t: 'drive', seq: 1, throttle: 0.25, steer: -0.5 } },
    { tUs: 1_200_000, line: 'not json at all' },
  ];

  async function play(): Promise<{ text: string; pending: number; received: string[] }> {
    const source = withControlScript(
      createFirmwareSource({ binary }),
      parseControlScript(timeline),
    );
    const run = await createRun({
      car: exampleCar,
      catalog: defaultCatalog,
      world: testWorldFile(),
      track: trackLibrary.load('oval'),
      seed: 1,
      source,
    });
    const cap = capture(run);
    await run.step(2000);
    const result = { text: cap.text(), pending: source.pending, received: [...source.received] };
    await run.stop();
    return result;
  }

  it('delivers each line to the firmware at its sim time, to the port hal mapped', async () => {
    const { text, pending } = await play();
    const lines = text.trim().split(/\r?\n/);
    expect(pending).toBe(0);
    expect(lines).toHaveLength(3);
    // each arrives within a millisecond or two of its time: the firmware accepts, then reads
    const parsed = lines.map((line) => /^\[(\d+)\] rx (.*)$/.exec(line) as RegExpExecArray);
    expect(parsed.map((m) => m[2])).toEqual([
      '{"t":"mode","mode":"manual"}',
      '{"t":"drive","seq":1,"throttle":0.25,"steer":-0.5}',
      'not json at all',
    ]);
    [500, 1000, 1200].forEach((ms, i) => {
      const at = Number((parsed[i] as RegExpExecArray)[1]);
      expect(at).toBeGreaterThanOrEqual(ms);
      expect(at).toBeLessThanOrEqual(ms + 2);
    });
  });

  it('is deterministic: the same timeline gives the same output', async () => {
    const a = await play();
    const b = await play();
    expect(b.text).toBe(a.text);
  });

  it('works through the rcsim CLI (--firmware and --control)', async () => {
    const write = (name: string, value: unknown): Promise<void> =>
      writeFile(path.join(dir, name), JSON.stringify(value));
    await write('car.json', exampleCar);
    await write('world.json', testWorldFile());
    await write('control.json', timeline);
    await write('bad-control.json', [{ tUs: 0 }]);
    let out = '';
    let err = '';
    const run = (...args: string[]): Promise<number> =>
      main(['run', '--car', 'car.json', '--world', 'world.json', '--seconds', '2', ...args], {
        cwd: dir,
        stdout: (t) => (out += t),
        stderr: (t) => (err += t),
      });

    expect(
      await run('--firmware', binary, '--control', 'control.json', '--assert', 'simSeconds == 2'),
    ).toBe(0);
    expect(JSON.parse(out)).toMatchObject({ passed: true, end: { kind: 'stopped' } });

    out = err = '';
    expect(await run('--firmware', binary, '--control', 'bad-control.json')).toBe(2);
    expect(err).toMatch(/control entry 0/);
  });
});
