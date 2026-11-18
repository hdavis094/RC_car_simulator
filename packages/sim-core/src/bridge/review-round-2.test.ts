// Regression tests for review round 2 of P1-H.
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { defaultCatalog, exampleCar } from '@rcsim/schema';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { ActuatorSource, ActuatorSourceSetup, TickInput } from '../api/actuator-source.ts';
import { createRun } from '../run/run.ts';
import { testWorldFile } from '../run/test-support.ts';
import { main } from '../scenario/cli.ts';
import { trackLibrary } from '../world/track-library.ts';
import {
  ControlledSource,
  MAX_CONTROL_BYTES_PER_TICK,
  parseControlScript,
  withControlScript,
} from './control-script.ts';
import { fakeFirmware } from './fake-firmware.ts';
import { createFirmwareSource } from './firmware-source.ts';
import { buildSketch, capture, removeProject } from './test-support.ts';

const setup: ActuatorSourceSetup = {
  car: exampleCar,
  catalog: defaultCatalog,
  seed: 1,
  tickUs: 1000,
  devices: [],
};
const tick = (n: number, extra: Partial<TickInput> = {}): TickInput => ({
  tick: n,
  t0Us: n * 1000,
  t1Us: (n + 1) * 1000,
  readings: [],
  gpioEdges: [],
  serialRx: new Uint8Array(0),
  ...extra,
});

let dir = '';
const projects: string[] = [];
const built: Record<string, string> = {};
const toStop: ActuatorSource[] = [];
const own = <T extends ActuatorSource>(source: T): T => {
  toStop.push(source);
  return source;
};
beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'rcsim-review2-'));
  for (const name of ['control-micros', 'pwm-once', 'control']) {
    const { binary, project } = await buildSketch(name);
    built[name] = binary;
    projects.push(project);
  }
}, 300_000);
afterAll(async () => {
  await Promise.all(toStop.map((s) => s.stop()));
  await Promise.all(projects.map(removeProject));
  await rm(dir, { recursive: true, force: true });
});
const fake = (name: string, body: string): Promise<string> => fakeFirmware(dir, name, body);

const realWrite = net.Socket.prototype.write;
afterEach(() => {
  net.Socket.prototype.write = realWrite;
});

describe('1. scripted control input is deterministic', () => {
  /** Control lines that reach the kernel late and at random, as a loaded machine delivers them. */
  const delayWrites = (): void => {
    let state = 12345;
    const random = (): number => (state = (state * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    net.Socket.prototype.write = function (this: net.Socket, ...args: never[]) {
      if (this.remotePort !== undefined) {
        setTimeout(() => realWrite.apply(this, args as never), Math.floor(random() * 12));
        return true;
      }
      return realWrite.apply(this, args as never);
    } as typeof net.Socket.prototype.write;
  };
  // Unfortunately not seeded per run: every run draws a different delay sequence.

  async function once(): Promise<string> {
    const entries = parseControlScript(
      Array.from({ length: 40 }, (_, k) => ({
        tUs: (k + 1) * 1000,
        line: 'x'.repeat(1500),
        everyMs: 0.001,
        untilUs: (k + 1) * 1000 + 19,
      })),
    );
    const source = withControlScript(
      createFirmwareSource({ binary: built['control-micros'] as string }),
      entries,
    );
    const run = await createRun({
      car: exampleCar,
      catalog: defaultCatalog,
      world: testWorldFile(),
      track: trackLibrary.load('oval'),
      seed: 1,
      source,
    });
    run.setNetFaults({ latencyUs: 0, lossPpm: 100_000, dropout: false });
    const cap = capture(run);
    await run.step(80);
    await run.stop();
    return crypto.createHash('sha256').update(cap.text()).digest('hex');
  }

  it('gives one hash over ten runs with network loss, however late the kernel delivers', async () => {
    const hashes: string[] = [];
    for (let i = 0; i < 10; i += 1) {
      delayWrites();
      hashes.push(await once());
      net.Socket.prototype.write = realWrite;
    }
    expect(new Set(hashes).size).toBe(1);
  }, 60_000);

  it('refuses more than a tick can deliver, before writing a byte', async () => {
    const arrived: string[] = [];
    const server = net.createServer((socket) => socket.on('data', (d) => arrived.push(String(d))));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const hostPort = (server.address() as net.AddressInfo).port;
    const inner: ActuatorSource = {
      start: async () => undefined,
      step: async (input) => ({
        pwm: [],
        gpioWrites: [],
        serialTx: new Uint8Array(0),
        logs: [],
        netEvents:
          input.tick === 0
            ? [
                {
                  type: 'listen',
                  proto: 'tcp',
                  firmwarePort: 3333,
                  hostPort,
                  bindAddress: '127.0.0.1',
                },
              ]
            : [],
      }),
      stop: async () => undefined,
    };
    const line = 'y'.repeat(100);
    const source = new ControlledSource(
      inner,
      parseControlScript(Array.from({ length: 40_000 }, () => ({ tUs: 1000, line }))),
    );
    await source.start(setup);
    await source.step(tick(0));
    const err = await source.step(tick(1)).catch((e: unknown) => e);
    expect(err).toMatchObject({
      end: {
        kind: 'error',
        message: expect.stringContaining(
          `control input for tick 1 exceeds ${MAX_CONTROL_BYTES_PER_TICK} bytes`,
        ) as unknown,
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(arrived).toEqual([]);
    expect(source.pending).toBe(40_000);
    await source.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});

describe('2. consecutive restarts', () => {
  it('still release the PWM the first firmware held', async () => {
    const run = await createRun({
      car: exampleCar,
      catalog: defaultCatalog,
      world: testWorldFile(),
      track: trackLibrary.load('oval'),
      seed: 1,
      source: own(createFirmwareSource({ binary: built['pwm-once'] as string })),
    });
    await run.step(4200);
    expect(run.snapshot().car.command.motorDuty).toBeGreaterThan(0);
    await run.restartFirmware();
    await run.restartFirmware(); // nothing was reported in between
    await run.step(500);
    expect(run.snapshot().car.command.motorDuty).toBe(0);
    await run.stop();
  });
});

describe('3. frames decoded before a malformed one', () => {
  it('are judged like any other: an unsolicited STEP_DONE in the same chunk ends the run', async () => {
    const binary = await fake(
      'decoded-bypass',
      `send(hello); await receive(); const s = await receive();
       socket.write(Buffer.concat([done(s.tick), { ...done(999), serialTx: new TextEncoder().encode('wrong tick accepted') }]
         .map(encodeFrame).concat([Buffer.from([1, 0, 0, 0, 0x7f])])));
       await new Promise((r) => setTimeout(r, 30000));`,
    );
    const run = await createRun({
      car: exampleCar,
      catalog: defaultCatalog,
      world: testWorldFile(),
      track: trackLibrary.load('oval'),
      seed: 1,
      source: own(createFirmwareSource({ binary })),
    });
    const cap = capture(run);
    const result = await run.step(3);
    // tick 0's own answer was valid and stands; the unsolicited frame behind it ends the run
    expect(result.ticks).toBe(1);
    expect(result.end).toMatchObject({ kind: 'error' });
    expect(JSON.stringify(result.end)).toMatch(/unexpected STEP_DONE/);
    expect(cap.text()).not.toContain('wrong tick accepted');
    await run.stop();
  });
});

describe('4. a firmware that is not reading its socket', () => {
  /** Makes every write to the bridge's own socket hang, as a full kernel buffer would. */
  const blockWritesTo = (socketPath: string): void => {
    net.Socket.prototype.write = function (this: net.Socket, ...args: never[]) {
      if ((this.server?.address() as unknown) === socketPath) return true; // never completes
      return realWrite.apply(this, args as never);
    } as typeof net.Socket.prototype.write;
  };
  const answering = (name: string): Promise<string> =>
    fake(
      name,
      `send(hello); await receive();
       for (;;) { const s = await receive(); if (s.type === 'BYE') process.exit(0); send(done(s.tick)); }`,
    );

  it('stalls the tick within the stall timeout even while the STEP is still being written', async () => {
    const source = own(
      createFirmwareSource({ binary: await answering('stuck-step'), stallTimeoutMs: 100 }),
    );
    await source.start(setup);
    blockWritesTo(source.socketPath);
    const started = Date.now();
    const outcome = await Promise.race([
      source.step(tick(0)).then(
        () => 'answered',
        (e: unknown) => e,
      ),
      new Promise((resolve) => setTimeout(() => resolve('hung'), 10_000)),
    ]);
    expect(outcome).toMatchObject({ end: { kind: 'stalled', afterMs: 100 } });
    expect(Date.now() - started).toBeLessThan(8000);
  });

  it('stops promptly: the kill deadline never waits for a BYE write', async () => {
    const source = own(
      createFirmwareSource({ binary: await answering('stuck-stop'), stallTimeoutMs: 20_000 }),
    );
    await source.start(setup);
    const pid = source.pid as number;
    blockWritesTo(source.socketPath);
    const stepping = source.step(tick(0)).then(
      () => 'answered',
      (e: unknown) => e,
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    const started = Date.now();
    const outcome = await Promise.race([
      source.stop().then(() => 'stopped'),
      new Promise((resolve) => setTimeout(() => resolve('hung'), 10_000)),
    ]);
    expect(outcome).toBe('stopped');
    expect(Date.now() - started).toBeLessThan(8000);
    expect(await stepping).toMatchObject({ end: { kind: 'finished' } });
    expect(() => process.kill(pid, 0)).toThrow();
    expect(existsSync(source.socketPath)).toBe(false);
  });
});

describe('5. control input that never reached the firmware', () => {
  it('fails the scenario instead of passing with bytes thrown away', async () => {
    const carDir = await mkdtemp(path.join(tmpdir(), 'rcsim-review2-cli-'));
    await writeFile(path.join(carDir, 'car.json'), JSON.stringify(exampleCar));
    await writeFile(path.join(carDir, 'world.json'), JSON.stringify(testWorldFile()));
    await writeFile(
      path.join(carDir, 'queued.json'),
      JSON.stringify([{ tUs: 1000, line: 'x'.repeat(4000), everyMs: 0.001, untilUs: 2999 }]),
    );
    let out = '';
    const code = await main(
      [
        'run',
        '--car',
        'car.json',
        '--world',
        'world.json',
        '--seconds',
        '0.004',
        '--firmware',
        built.control as string,
        '--control',
        'queued.json',
      ],
      { cwd: carDir, stdout: (t) => (out += t), stderr: () => undefined },
    );
    const result = JSON.parse(out) as { passed: boolean; end: { kind: string; message: string } };
    expect(code).toBe(1);
    expect(result.passed).toBe(false);
    expect(result.end.kind).toBe('error');
    expect(result.end.message).toMatch(/control input for tick \d+ exceeds/);
    await rm(carDir, { recursive: true, force: true });
  });
});
