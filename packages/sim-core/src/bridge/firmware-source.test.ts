import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { defaultCatalog, exampleCar, type ServoParams } from '@rcsim/schema';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ActuatorSourceEnded, type ActuatorSource } from '../api/actuator-source.ts';
import type { RunOptions } from '../api/run.ts';
import { createFakeSensorModel } from '../api/stubs/fake-models.ts';
import { createRun, type MeasuredRun } from '../run/run.ts';
import { testRun, testWorldFile } from '../run/test-support.ts';
import { main } from '../scenario/cli.ts';
import { snapshotHash } from '../scenario/hash.ts';
import { trackLibrary } from '../world/track-library.ts';
import { createFirmwareSource, type FirmwareSource } from './firmware-source.ts';
import { buildSketch, capture, removeProject } from './test-support.ts';

const sketches = ['sweep', 'ticker', 'spin', 'abort', 'exit', 'echo', 'reboot', 'ranger', 'hcsr04'];
const built: Record<string, string> = {};
const projects: string[] = [];

beforeAll(async () => {
  // Sequential: the first build also builds (and caches) the hal library.
  for (const name of sketches) {
    const { binary, project } = await buildSketch(name);
    built[name] = binary;
    projects.push(project);
  }
}, 300_000);
afterAll(async () => {
  await Promise.all(projects.map(removeProject));
});

const sources: ActuatorSource[] = [];
afterAll(async () => {
  await Promise.all(sources.map((s) => s.stop()));
});

function firmware(name: string, stallTimeoutMs?: number): FirmwareSource {
  const source = createFirmwareSource({
    binary: built[name] as string,
    ...(stallTimeoutMs !== undefined ? { stallTimeoutMs } : {}),
  });
  sources.push(source);
  return source;
}

const runs: MeasuredRun[] = [];
async function startRun(
  name: string,
  options: Partial<Pick<RunOptions, 'seed' | 'createSensorModel'>> = {},
  source: ActuatorSource = firmware(name),
): Promise<MeasuredRun> {
  const run = await createRun({
    car: exampleCar,
    catalog: defaultCatalog,
    world: testWorldFile({ seed: options.seed ?? 1 }),
    track: trackLibrary.load('oval'),
    seed: options.seed ?? 1,
    source,
    ...(options.createSensorModel ? { createSensorModel: options.createSensorModel } : {}),
  });
  runs.push(run);
  return run;
}
afterAll(async () => {
  await Promise.all(runs.map((r) => r.stop()));
});

describe('the firmware bridge running a sketch', () => {
  it('makes the steering angle follow a servo sweep, within the slew limit', async () => {
    const run = await startRun('sweep');
    const servo = defaultCatalog.get('actuator.mg996r');
    if (!servo || !('behavior' in servo) || servo.behavior.template !== 'servo') throw new Error();
    const p: ServoParams = servo.behavior.params;
    const dtS = run.clock.tickUs / 1e6;
    const slewRad = (p.slewDegPerS * dtS * 0.7 * Math.PI) / 180; // per tick, at the wheels
    const idealRad = (pulseUs: number): number =>
      Math.max(
        -(28 * Math.PI) / 180,
        Math.min(
          (28 * Math.PI) / 180,
          (-((pulseUs - p.pulseNeutralUs) / (p.pulseMaxUs - p.pulseMinUs)) *
            p.travelDeg *
            0.7 *
            Math.PI) /
            180,
        ),
      );
    const cap = capture(run);

    const steer: number[] = [];
    for (let i = 0; i < 8000; i += 1) {
      await run.step(1);
      steer.push(run.snapshot().car.command.steerAngleRad);
    }
    expect(run.status).toBe('running');

    // never faster than the servo can slew
    for (let i = 1; i < steer.length; i += 1) {
      expect(Math.abs((steer[i] as number) - (steer[i - 1] as number))).toBeLessThanOrEqual(
        slewRad + 1e-12,
      );
    }
    // follows the commanded pulse: after each write it is within one tick's slew of the target
    const writes = cap.serial.flatMap((s) =>
      s.text
        .split(/\r?\n/)
        .filter(Boolean)
        .map((t) => ({ tUs: s.tUs, pulse: Number(t) })),
    );
    expect(writes.length).toBeGreaterThan(300);
    for (const w of writes) {
      const tick = w.tUs / run.clock.tickUs;
      // the write lands in tick `tick`, so its effect is visible after that tick
      expect(Math.abs((steer[tick] as number) - idealRad(w.pulse))).toBeLessThanOrEqual(
        slewRad + 0.002,
      );
    }
    // and the sweep reaches both ends
    expect(Math.max(...steer)).toBeGreaterThan(idealRad(1100) - 1e-3);
    expect(Math.min(...steer)).toBeLessThan(idealRad(1900) + 1e-3);
  });

  it('keeps sim time exact: a once-a-second print is spaced by exactly 1000 ms', async () => {
    const run = await startRun('ticker');
    const cap = capture(run);
    await run.step(6000);
    expect(cap.serial.map((s) => s.tUs)).toEqual([
      1_000_000, 2_000_000, 3_000_000, 4_000_000, 5_000_000,
    ]);
    expect(cap.text().trim().split(/\s+/)).toEqual(['1000', '2000', '3000', '4000', '5000']);
  });

  it('ends a sketch that never calls hal as stalled, within 3 s of wall time', async () => {
    const run = await startRun('spin');
    const cap = capture(run);
    const started = performance.now();
    const result = await run.step(10);
    const wallMs = performance.now() - started;
    expect(wallMs).toBeLessThan(3000);
    expect(result.status).toBe('ended');
    expect(result.end).toEqual({ kind: 'stalled', afterMs: 2000 });
    expect(cap.ends).toEqual([{ kind: 'stalled', afterMs: 2000 }]);
  });

  it('uses the configured stall timeout', async () => {
    const run = await startRun('spin', {}, firmware('spin', 300));
    const started = performance.now();
    const result = await run.step(1);
    expect(result.end).toEqual({ kind: 'stalled', afterMs: 300 });
    expect(performance.now() - started).toBeLessThan(1500);
  });

  it('ends an aborting sketch as crashed, with the signal and the last stderr lines', async () => {
    const run = await startRun('abort');
    const cap = capture(run);
    const result = await run.step(500);
    expect(result.end).toEqual({
      kind: 'crashed',
      exitCode: null,
      signal: 'SIGABRT',
      stderrTail: ['fatal: the sketch gave up'],
    });
    // the run kept what the sketch said before it died
    expect(cap.text()).toContain('about to abort');
    expect(result.ticks).toBeGreaterThan(0);
    expect(result.ticks).toBeLessThan(500);
  });

  it('reports the exit code of a sketch that calls exit()', async () => {
    const run = await startRun('exit');
    const result = await run.step(500);
    expect(result.end).toMatchObject({ kind: 'crashed', exitCode: 3, signal: null });
    expect(result.end?.kind === 'crashed' && result.end.stderrTail.join('\n')).toContain('exit()');
  });

  it('gives identical serial output and snapshot hashes for the same seed and firmware', async () => {
    const once = async (): Promise<{ text: string; hash: string }> => {
      const run = await startRun(
        'sweep',
        { seed: 7 },
        createFirmwareSource({ binary: built.sweep as string }),
      );
      const cap = capture(run);
      await run.step(3000);
      const result = { text: cap.text(), hash: snapshotHash(run.snapshot()) };
      await run.stop();
      return result;
    };
    const a = await once();
    const b = await once();
    expect(a.text.length).toBeGreaterThan(100);
    expect(b).toEqual(a);
  });

  it('delivers Serial RX, split across ticks when it exceeds one STEP', async () => {
    const run = await startRun('echo');
    const cap = capture(run);
    await run.step(5);
    run.sendSerial(new TextEncoder().encode('hi'));
    await run.step(50);
    expect(cap.text()).toMatch(/^\[\d+\]h\n\[\d+\]i\n$/);

    // 20 000 bytes: more than the 16 384 one STEP may carry. hal's own receive queue
    // holds 16 384 and drops the excess, as a UART buffer would; what arrives is in order.
    const pattern = (i: number): string => String.fromCharCode(97 + (i % 26));
    run.sendSerial(Uint8Array.from({ length: 20_000 }, (_, i) => pattern(i).charCodeAt(0)));
    await run.step(1000);
    const echoed = [...cap.text().matchAll(/\]([a-z])\n/g)].map((m) => m[1]).slice(2);
    expect(echoed.length).toBeGreaterThanOrEqual(16_384);
    expect(echoed.slice(0, 16_384).join('')).toBe(
      Array.from({ length: 16_384 }, (_, i) => pattern(i)).join(''),
    );
  });

  it('maps sensor readings to the right device', async () => {
    const run = await startRun('ranger', {
      createSensorModel: (part) =>
        createFakeSensorModel(part, {
          mm:
            part.instance.instanceId === 'tof_left'
              ? 300
              : part.instance.instanceId === 'tof_centre'
                ? 600
                : 900,
        }),
    });
    const cap = capture(run);
    await run.step(1000);
    expect(cap.text()).not.toContain('INIT FAILED');
    const lines = cap.text().trim().split(/\r?\n/);
    expect(lines.length).toBeGreaterThan(5);
    expect(lines.at(-1)).toBe('300,600,900');
  });
});

describe('restart', () => {
  it('reboots the firmware while the world carries on', async () => {
    const run = await startRun('reboot');
    const cap = capture(run);
    await run.step(250);
    expect(cap.text()).toBe('boot 0\nup 100\nup 200\n');
    const before = run.clock.tick;
    await run.restartFirmware();
    expect(run.status).toBe('running');
    await run.step(250);
    expect(run.clock.tick).toBe(before + 250);
    // setup() ran again at the current tick; the firmware's own clock starts from its boot
    expect(cap.text()).toBe('boot 0\nup 100\nup 200\nboot 0\nup 100\nup 200\n');
    expect(cap.serial.at(-3)?.tUs).toBe(before * 1000);
    expect(run.end).toBeNull();
  });

  it('can be asked to restart before the first tick', async () => {
    const run = await startRun('reboot');
    await run.restartFirmware();
    const cap = capture(run);
    await run.step(150);
    expect(cap.text()).toBe('boot 0\nup 100\n');
  });

  it('cannot restart a stopped source', async () => {
    const source = firmware('reboot');
    const run = await startRun('reboot', {}, source);
    await run.stop();
    await expect(source.restart()).rejects.toThrow(/stopped/);
  });
});

describe('lifecycle', () => {
  it('stops cleanly mid-run and may be stopped twice', async () => {
    const run = await startRun('ticker');
    await run.step(10);
    await run.stop();
    await run.stop();
    expect(run.end).toEqual({ kind: 'stopped' });
  });

  it('removes its socket and leaves no process behind', async () => {
    const source = firmware('ticker');
    const run = await startRun('ticker', {}, source);
    await run.step(10);
    expect(existsSync(source.socketPath)).toBe(true);
    await run.stop();
    expect(existsSync(source.socketPath)).toBe(false);
  });

  it('a stop during a step ends that step, not as a failure', async () => {
    const run = await startRun('spin', {}, firmware('spin', 10_000));
    const stepping = run.step(1);
    await new Promise((resolve) => setTimeout(resolve, 200));
    await run.stop();
    const result = await stepping;
    expect(result.status).toBe('ended');
    expect(run.end).toEqual({ kind: 'stopped' });
  });

  it('reports a missing binary as an error', async () => {
    const source = createFirmwareSource({ binary: '/nonexistent/firmware' });
    const err = await testRun({ source }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ActuatorSourceEnded);
    expect((err as ActuatorSourceEnded).end).toMatchObject({ kind: 'error' });
    expect(JSON.stringify((err as ActuatorSourceEnded).end)).toContain('/nonexistent/firmware');
  });

  it('keeps its socket path under 100 bytes', async () => {
    const source = firmware('ticker');
    await startRun('ticker', {}, source);
    expect(source.socketPath).toMatch(/^\/tmp\/rcsim-\d+-\d+\.sock$/);
    expect(Buffer.byteLength(source.socketPath)).toBeLessThan(100);
  });
});

describe('GPIO', () => {
  it('carries GPIO writes out and input edges in (an HC-SR04 echo)', async () => {
    const source = firmware('hcsr04');
    await source.start({
      car: exampleCar,
      catalog: defaultCatalog,
      seed: 1,
      tickUs: 1000,
      devices: [],
    });
    const text: string[] = [];
    const writes: { gpio: number; tUs: number; level: boolean }[] = [];
    const due: { gpio: number; tUs: number; level: boolean }[] = [];
    for (let tick = 0; tick < 200; tick += 1) {
      const t0Us = tick * 1000;
      const t1Us = t0Us + 1000;
      const edges = due.filter((e) => e.tUs >= t0Us && e.tUs < t1Us);
      const out = await source.step({
        tick,
        t0Us,
        t1Us,
        readings: [],
        gpioEdges: edges,
        serialRx: new Uint8Array(0),
      });
      text.push(new TextDecoder().decode(out.serialTx));
      for (const w of out.gpioWrites) {
        writes.push(w);
        // the part answers a trigger's falling edge one tick later with a 1160 us pulse (20 cm)
        if (w.gpio === 5 && !w.level) {
          due.push(
            { gpio: 18, tUs: t1Us, level: true },
            { gpio: 18, tUs: t1Us + 1160, level: false },
          );
        }
      }
    }
    await source.stop();
    // TRIG: setup() drives it low, then each measurement is a 10 us high pulse
    expect(writes[0]).toMatchObject({ gpio: 5, level: false });
    const rise = writes.findIndex((w) => w.level);
    const trig = writes.slice(rise, rise + 2);
    expect(trig.map((w) => w.level)).toEqual([true, false]);
    // 10 us of delayMicroseconds plus the 1 us the hal call costs
    expect((trig[1]?.tUs ?? 0) - (trig[0]?.tUs ?? 0)).toBe(11);
    // ECHO: pulseIn measured the width of the edges the bridge delivered (hal's call costs add a few us)
    const widths =
      text
        .join('')
        .match(/echo (\d+)/g)
        ?.map((m) => Number(m.slice(5))) ?? [];
    expect(widths.length).toBeGreaterThan(2);
    for (const width of widths) expect(Math.abs(width - 1160)).toBeLessThanOrEqual(5);
  });
});

describe('rcsim run --firmware', () => {
  let dir = '';
  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'rcsim-cli-fw-'));
    await writeFile(path.join(dir, 'car.json'), JSON.stringify(exampleCar));
    await writeFile(path.join(dir, 'world.json'), JSON.stringify(testWorldFile()));
  });
  afterAll(() => rm(dir, { recursive: true, force: true }));

  async function rcsim(...args: string[]): Promise<{ code: number; out: string; err: string }> {
    let out = '';
    let err = '';
    const code = await main(
      ['run', '--car', 'car.json', '--world', 'world.json', '--seed', '3', ...args],
      { cwd: dir, stdout: (t) => (out += t), stderr: (t) => (err += t) },
    );
    return { code, out, err };
  }

  it('passes for a healthy firmware and asserts on the run', async () => {
    const r = await rcsim(
      '--firmware',
      built.ticker as string,
      '--seconds',
      '2',
      '--assert',
      'simSeconds == 2',
    );
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toMatchObject({ passed: true, end: { kind: 'stopped' } });
  });

  it('gives the same snapshot hash on every run', async () => {
    const hash = async (): Promise<string> =>
      (
        JSON.parse((await rcsim('--firmware', built.sweep as string, '--seconds', '2')).out) as {
          snapshotHash: string;
        }
      ).snapshotHash;
    expect(await hash()).toBe(await hash());
  });

  it('fails the scenario when the firmware crashes, and says how', async () => {
    const r = await rcsim('--firmware', built.abort as string, '--seconds', '2');
    expect(r.code).toBe(1);
    expect(JSON.parse(r.out)).toMatchObject({
      passed: false,
      end: { kind: 'crashed', signal: 'SIGABRT' },
    });
  });

  it('fails the scenario when the firmware stalls', async () => {
    const r = await rcsim('--firmware', built.spin as string, '--seconds', '2');
    expect(r.code).toBe(1);
    expect(JSON.parse(r.out)).toMatchObject({ passed: false, end: { kind: 'stalled' } });
  });

  it('refuses a binary that does not exist, before running anything', async () => {
    const r = await rcsim('--firmware', 'nope/firmware', '--seconds', '1');
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/cannot find firmware "nope\/firmware".*build-sim/);
  });
});
