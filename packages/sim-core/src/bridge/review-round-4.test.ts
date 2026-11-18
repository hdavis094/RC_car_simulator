// Regression tests for review round 4 of P1-H, and for the startup deadline.
import { readFile } from 'node:fs/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { defaultCatalog, exampleCar } from '@rcsim/schema';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ActuatorSource, ActuatorSourceSetup, TickInput } from '../api/actuator-source.ts';
import { ControlledSource, parseControlScript } from './control-script.ts';
import { fakeFirmware } from './fake-firmware.ts';
import { createFirmwareSource } from './firmware-source.ts';

// Waits in these tests are wall-clock and CI is slow: no test may time out before the longest wait it allows.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 300_000 });

const setup: ActuatorSourceSetup = {
  car: exampleCar,
  catalog: defaultCatalog,
  seed: 1,
  tickUs: 1000,
  devices: [],
};
const tick = (n: number): TickInput => ({
  tick: n,
  t0Us: n * 1000,
  t1Us: (n + 1) * 1000,
  readings: [],
  gpioEdges: [],
  serialRx: new Uint8Array(0),
});
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const until = async (what: () => boolean, ms: number): Promise<boolean> => {
  for (const end = Date.now() + ms; Date.now() < end;) {
    if (what()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return what();
};

let dir = '';
beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'rcsim-review4-'));
});
afterAll(() => rm(dir, { recursive: true, force: true }));
const fake = (name: string, body: string): Promise<string> => fakeFirmware(dir, name, body);

const realWrite = net.Socket.prototype.write;
afterEach(() => {
  net.Socket.prototype.write = realWrite;
});

describe('startup has its own deadline', () => {
  it('does not count a slow start against the per-step stall timeout', async () => {
    // Takes 600 ms to say HELLO: six times the step stall timeout, well inside startup's.
    const binary = await fake(
      'slow-start',
      `await new Promise((r) => setTimeout(r, 600));
       send(hello); await receive();
       for (;;) { const s = await receive(); if (s.type === 'BYE') process.exit(0); send(done(s.tick)); }`,
    );
    const source = createFirmwareSource({ binary, stallTimeoutMs: 100 });
    try {
      await source.start(setup);
      await source.step(tick(0)); // and steps still answer inside 100 ms
    } finally {
      await source.stop();
    }
  });

  it('ends a start that takes longer than the startup timeout, as stalled', async () => {
    const binary = await fake('never-hello', `await new Promise((r) => setTimeout(r, 30000));`);
    const source = createFirmwareSource({ binary, startupTimeoutMs: 300 });
    const err = await source.start(setup).catch((e: unknown) => e);
    expect(err).toMatchObject({ end: { kind: 'stalled' } });
    const afterMs = (err as { end: { afterMs: number } }).end.afterMs;
    // Node timers may fire ~1 ms early relative to performance.now().
    expect(afterMs).toBeGreaterThanOrEqual(298);
    expect(afterMs).toBeLessThan(5000);
    await source.stop();
  });
});

describe('1. a failed control batch is never replayed, across ports either', () => {
  it('refuses every later step after one port failed and another could not be reached', async () => {
    // Port 3333 takes ten lines and then the write fails; port 4444 refuses connections.
    const lines: string[] = [];
    let connectionsToA = 0;
    const peers: net.Socket[] = [];
    const a = net.createServer((socket) => {
      connectionsToA += 1;
      peers.push(socket);
      socket.setEncoding('utf8');
      let text = '';
      socket.on('data', (d: string) => {
        text += d;
        lines.splice(0, lines.length, ...text.split('\n').filter(Boolean));
      });
      socket.on('error', () => undefined);
    });
    await new Promise<void>((resolve) => a.listen(0, '127.0.0.1', resolve));
    const portA = (a.address() as net.AddressInfo).port;
    const spare = net.createServer();
    await new Promise<void>((resolve) => spare.listen(0, '127.0.0.1', resolve));
    const refused = (spare.address() as net.AddressInfo).port;
    await new Promise<void>((resolve) => spare.close(() => resolve()));

    let failedOnce = false;
    net.Socket.prototype.write = function (this: net.Socket, ...args: unknown[]) {
      if (this.remotePort === portA && !failedOnce) {
        failedOnce = true;
        const [data, callback] = args as [string, (error?: Error) => void];
        realWrite.call(this, data.slice(0, 1000), 'utf8', () => {
          // reports its failure only after the other port's refusal has been thrown
          setTimeout(() => {
            callback(new Error('read ECONNRESET'));
            this.destroy();
          }, 30);
        });
        return true;
      }
      return realWrite.apply(this, args as never);
    } as typeof net.Socket.prototype.write;

    const inner: ActuatorSource = {
      start: async () => undefined,
      stop: async () => undefined,
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
                  hostPort: portA,
                  bindAddress: '127.0.0.1',
                },
                {
                  type: 'listen',
                  proto: 'tcp',
                  firmwarePort: 4444,
                  hostPort: refused,
                  bindAddress: '127.0.0.1',
                },
              ]
            : [],
      }),
    };
    const entries = parseControlScript([
      ...Array.from({ length: 300 }, (_, i) => ({
        tUs: 1000,
        port: 3333,
        line: `${String(i).padStart(3, '0')}:${'x'.repeat(95)}`,
      })),
      { tUs: 1000, port: 4444, line: 'B' },
    ]);
    const source = new ControlledSource(inner, entries, { stallTimeoutMs: 5000 });
    await source.start(setup);
    await source.step(tick(0));
    const first = await source.step(tick(1)).catch((e: unknown) => e);
    expect(first).toMatchObject({ end: { kind: 'error' } }); // the refused port, or the reset
    await new Promise((resolve) => setTimeout(resolve, 200)); // the reset surfaces
    // Whatever order things failed in, the source is finished: nothing is resent.
    for (const n of [2, 3]) {
      await expect(source.step(tick(n))).rejects.toMatchObject({ end: { kind: 'error' } });
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(connectionsToA).toBe(1);
    expect(lines).toHaveLength(10);
    // and the ambiguity is what it reports
    await expect(source.step(tick(4))).rejects.toMatchObject({
      end: {
        message: expect.stringMatching(
          /port 3333 reset during tick 1; delivery ambiguous/,
        ) as unknown,
      },
    });
    await source.stop();
    for (const p of peers) p.destroy();
    await new Promise<void>((resolve) => a.close(() => resolve()));
  });
});

describe('2. a helper that inherited the firmware’s pipes', () => {
  it('does not keep a stalled firmware, its step or stop() alive, and dies with it', async () => {
    const helperPid = path.join(dir, 'helper.pid');
    const binary = await fake(
      'inherited-pipes',
      `import { spawn } from 'node:child_process';
       import { writeFileSync } from 'node:fs';
       send(hello); await receive(); await receive(); // CONFIG, then the first STEP
       const helper = spawn('sleep', ['30'], { stdio: ['ignore', 'inherit', 'inherit'] });
       writeFileSync(${JSON.stringify(helperPid)}, String(helper.pid));
       for (;;) {}`,
    );
    const source = createFirmwareSource({ binary, stallTimeoutMs: 300 });
    await source.start(setup);
    const pid = source.pid as number;
    const stepping = source.step(tick(0)).then(
      () => 'answered',
      (e: unknown) => e,
    );
    const outcome = await Promise.race([
      stepping,
      new Promise((resolve) => setTimeout(() => resolve('hung'), 10_000)),
    ]);
    const helper = Number(await readFile(helperPid, 'utf8').catch(() => '0'));
    try {
      expect(outcome).toMatchObject({ end: { kind: 'stalled', afterMs: 300 } });
      const stopped = await Promise.race([
        source.stop().then(() => 'stopped'),
        new Promise((resolve) => setTimeout(() => resolve('hung'), 10_000)),
      ]);
      expect(stopped).toBe('stopped');
      expect(alive(pid)).toBe(false);
      expect(helper).toBeGreaterThan(0);
      expect(await until(() => !alive(helper), 5000)).toBe(true); // no helper survives
    } finally {
      if (helper > 0 && alive(helper)) process.kill(helper, 'SIGKILL');
    }
  }, 40_000);

  it('also reaps helpers of a firmware that exits by itself', async () => {
    const helperPid = path.join(dir, 'helper2.pid');
    const binary = await fake(
      'exits-with-helper',
      `import { spawn } from 'node:child_process';
       import { writeFileSync } from 'node:fs';
       send(hello); await receive(); await receive();
       const helper = spawn('sleep', ['30'], { stdio: ['ignore', 'inherit', 'inherit'] });
       writeFileSync(${JSON.stringify(helperPid)}, String(helper.pid));
       console.error('goodbye');
       process.exit(4);`,
    );
    const source = createFirmwareSource({ binary });
    await source.start(setup);
    const err = await source.step(tick(0)).catch((e: unknown) => e);
    const helper = Number(await readFile(helperPid, 'utf8').catch(() => '0'));
    try {
      expect(err).toMatchObject({ end: { kind: 'crashed', exitCode: 4, stderrTail: ['goodbye'] } });
      expect(await until(() => !alive(helper), 5000)).toBe(true);
    } finally {
      if (helper > 0 && alive(helper)) process.kill(helper, 'SIGKILL');
      await source.stop();
    }
  }, 40_000);
});
