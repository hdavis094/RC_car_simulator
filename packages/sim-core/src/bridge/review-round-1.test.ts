// Regression tests for review round 1 of P1-H. Each one fails on 3d766a3.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultCatalog, exampleCar } from '@rcsim/schema';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  ActuatorSource,
  ActuatorSourceSetup,
  TickInput,
  TickOutput,
} from '../api/actuator-source.ts';
import { createRun } from '../run/run.ts';
import { testWorldFile } from '../run/test-support.ts';
import { main } from '../scenario/cli.ts';
import { trackLibrary } from '../world/track-library.ts';
import { ControlledSource, parseControlScript, withControlScript } from './control-script.ts';
import { fakeFirmware } from './fake-firmware.ts';
import { createFirmwareSource } from './firmware-source.ts';
import { killAllFirmware } from './process.ts';
import { buildSketch, removeProject } from './test-support.ts';

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
const projects: string[] = [];
const built: Record<string, string> = {};
const toStop: ActuatorSource[] = [];
beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'rcsim-review1-'));
  for (const name of ['spin', 'control', 'pwm-once', 'ticker']) {
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
const own = <T extends ActuatorSource>(source: T): T => {
  toStop.push(source);
  return source;
};

describe('1. per-tick waits do not accumulate', () => {
  it('attaches a constant number of reactions to the process exit, however many ticks run', async () => {
    const binary = await fake(
      'answers',
      `send(hello); await receive();
       for (;;) { const s = await receive(); if (s.type === 'BYE') process.exit(0); send(done(s.tick)); }`,
    );
    const source = own(createFirmwareSource({ binary }));
    await source.start(setup);
    const exit = (source.process as NonNullable<typeof source.process>).exit;
    let reactions = 0;
    const attach = exit.then.bind(exit);
    exit.then = ((...args: Parameters<typeof attach>) => {
      reactions += 1;
      return attach(...args);
    }) as typeof exit.then;
    for (let n = 0; n < 3000; n += 1) await source.step(tick(n));
    // Each tick used to add one that was never removed.
    expect(reactions).toBeLessThan(10);
  });
});

describe('2. control input never blocks a tick', () => {
  async function runWith(entries: ReturnType<typeof parseControlScript>, ticks: number) {
    const source = own(
      withControlScript(
        createFirmwareSource({ binary: built.control as string, stallTimeoutMs: 2000 }),
        entries,
        { stallTimeoutMs: 2000 },
      ),
    );
    const run = await createRun({
      car: exampleCar,
      catalog: defaultCatalog,
      world: testWorldFile(),
      track: trackLibrary.load('oval'),
      seed: 1,
      source,
    });
    const outcome = await Promise.race([
      run.step(ticks),
      new Promise<'hung'>((resolve) => setTimeout(() => resolve('hung'), 15_000)),
    ]);
    await run.stop();
    return outcome;
  }

  it('keeps stepping while the firmware has tens of KiB of control lines to read', async () => {
    // 8 lines of 4000 bytes in each of three ticks, read by the sketch at a line per ms.
    const line = 'x'.repeat(4000);
    const entries = parseControlScript(
      [1000, 2000, 3000].flatMap((tUs) => Array.from({ length: 8 }, () => ({ tUs, line }))),
    );
    const outcome = await runWith(entries, 60);
    expect(outcome).toMatchObject({ ticks: 60, status: 'running' });
  }, 30_000);

  it('ends with a clear error, not a hang, when one tick is due more than it can deliver', async () => {
    const line = 'x'.repeat(4000);
    const entries = parseControlScript(Array.from({ length: 2000 }, () => ({ tUs: 1000, line })));
    const outcome = await runWith(entries, 60);
    expect(outcome).not.toBe('hung');
    expect(outcome).toMatchObject({
      status: 'ended',
      end: {
        kind: 'error',
        message: expect.stringMatching(/control input for tick 1 exceeds 32768 bytes/) as unknown,
      },
    });
  }, 30_000);
});

describe('3. a reboot drops the PWM the old firmware held', () => {
  it('leaves an armed ESC without a signal, so the car stops', async () => {
    const run = await createRun({
      car: exampleCar,
      catalog: defaultCatalog,
      world: testWorldFile(),
      track: trackLibrary.load('oval'),
      seed: 1,
      source: own(createFirmwareSource({ binary: built['pwm-once'] as string })),
    });
    await run.step(4200); // armed after 3.2 s of neutral, then 1600 µs: driving
    expect(run.snapshot().car.command.motorDuty).toBeGreaterThan(0);
    await run.restartFirmware(); // the new firmware never attaches PWM
    await run.step(5);
    expect(run.snapshot().car.command.motorDuty).toBe(0);
    await run.step(2000);
    expect(run.snapshot().car.command.motorDuty).toBe(0);
    await run.stop();
  });
});

describe('4. stopping while starting', () => {
  it.each([0, 50])('leaves no socket and no process (stop after %i ms)', async (afterMs) => {
    const pidFile = path.join(dir, `mute-${afterMs}.pid`);
    const binary = await fake(
      `mute-${afterMs}`,
      `import { writeFileSync } from 'node:fs';
       writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
       await new Promise((r) => setTimeout(r, 30000));`,
    );
    const source = createFirmwareSource({ binary, stallTimeoutMs: 1000 });
    const starting = source.start(setup).then(
      () => 'started',
      (error: unknown) => error,
    );
    // 0 ms: stop in the same breath as start, while it is still on its first await.
    if (afterMs > 0) await new Promise((resolve) => setTimeout(resolve, afterMs));
    await source.stop();
    await starting; // however it ended
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(existsSync(source.socketPath)).toBe(false);
    if (existsSync(pidFile)) {
      const pid = Number(await readFile(pidFile, 'utf8'));
      expect(await until(() => !alive(pid), 5000)).toBe(true);
    }
    await source.stop(); // twice is fine
  });
});

describe('5. the host going away', () => {
  async function host(
    mode: string,
  ): Promise<{ pid: number; socket: string; hostExit: Promise<void>; kill(): void }> {
    const script = fileURLToPath(new URL('./fixtures/host.ts', import.meta.url));
    const child = spawn(process.execPath, [script, built.spin as string, mode], {
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    const hostExit = new Promise<void>((resolve) => child.once('close', () => resolve()));
    const [pid, socket] = await new Promise<[number, string]>((resolve, reject) => {
      let text = '';
      child.stdout.on('data', (chunk: Buffer) => {
        text += chunk.toString();
        const match = /pid (\d+) socket (\S+)/.exec(text);
        if (match) resolve([Number(match[1]), match[2] as string]);
      });
      child.once('close', () => reject(new Error(`host exited early: ${text}`)));
    });
    return { pid, socket, hostExit, kill: () => child.kill('SIGTERM') };
  }

  it('SIGTERM to a host that installed the handlers kills a spinning firmware', async () => {
    const h = await host('install-handlers');
    expect(alive(h.pid)).toBe(true);
    h.kill();
    await h.hostExit;
    expect(await until(() => !alive(h.pid), 8000)).toBe(true);
    expect(existsSync(h.socket)).toBe(false); // and no socket file is left behind
  }, 30_000);

  it('killAllFirmware() kills it from inside the host', async () => {
    const source = own(
      createFirmwareSource({ binary: built.spin as string, stallTimeoutMs: 20_000 }),
    );
    await source.start(setup);
    const stepping = source.step(tick(0)).then(
      () => undefined,
      (error: unknown) => error,
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
    const pid = source.pid as number;
    expect(alive(pid)).toBe(true);
    killAllFirmware();
    expect(await until(() => !alive(pid), 8000)).toBe(true);
    expect(await stepping).toMatchObject({ end: { kind: 'crashed', signal: 'SIGKILL' } });
  });
});

describe('6. messages are judged when they arrive', () => {
  async function ends(body: string): Promise<{ ticks: number; end: unknown }> {
    const binary = await fake(`early-${Math.random().toString(36).slice(2)}`, body);
    const run = await createRun({
      car: exampleCar,
      catalog: defaultCatalog,
      world: testWorldFile(),
      track: trackLibrary.load('oval'),
      seed: 1,
      source: own(createFirmwareSource({ binary, stallTimeoutMs: 5000 })),
    }).catch((error: unknown) => ({ failed: error }));
    if ('failed' in run) return { ticks: 0, end: (run.failed as { end?: unknown }).end };
    const result = await run.step(20);
    await run.stop();
    return { ticks: result.ticks, end: result.end };
  }

  it('refuses STEP_DONE frames that arrive before CONFIG', async () => {
    const result = await ends(
      `socket.write(Buffer.concat([hello, ...Array.from({ length: 10 }, (_, i) => done(i))].map(encodeFrame)));
       await new Promise((r) => setTimeout(r, 5000));`,
    );
    expect(result.ticks).toBe(0);
    expect(JSON.stringify(result.end)).toMatch(/error/);
    expect(JSON.stringify(result.end)).toMatch(/unexpected STEP_DONE/);
  });

  it('refuses a second STEP_DONE for a tick that is already answered', async () => {
    const result = await ends(
      `send(hello); await receive(); const s = await receive();
       socket.write(Buffer.concat([done(s.tick), done(s.tick)].map(encodeFrame)));
       await new Promise((r) => setTimeout(r, 5000));`,
    );
    // The first answer is good; the run notices the duplicate at the next tick.
    expect(result.ticks).toBeLessThanOrEqual(1);
    expect(JSON.stringify(result.end)).toMatch(
      /unexpected STEP_DONE; the sim is waiting for nothing/,
    );
  });

  it('refuses a STEP_DONE for a tick not yet sent', async () => {
    const result = await ends(
      `send(hello); await receive(); await receive(); send(done(1)); await new Promise((r) => setTimeout(r, 5000));`,
    );
    expect(result.ticks).toBe(0);
    expect(JSON.stringify(result.end)).toMatch(/STEP_DONE 1 does not answer STEP 0/);
  });
});

describe('7-8. control timelines: seq and timing', () => {
  it('wraps a repeated drive’s seq at 2^32', () => {
    const entries = parseControlScript([
      {
        tUs: 0,
        message: { t: 'drive', seq: 4294967295, throttle: 0, steer: 0 },
        everyMs: 10,
        untilUs: 25_000,
      },
    ]);
    expect(entries.map((e) => (JSON.parse(e.line) as { seq: number }).seq)).toEqual([
      4294967295, 0, 1,
    ]);
  });

  /** A stand-in firmware that reports a TCP server and records, per tick, how many lines had arrived. */
  class FakeFirmware implements ActuatorSource {
    readonly arrived: string[] = [];
    readonly afterTick: number[] = [];
    readonly #server = net.createServer((socket) => {
      socket.setEncoding('utf8');
      let tail = '';
      socket.on('data', (text: string) => {
        const lines = (tail + text).split('\n');
        tail = lines.pop() ?? '';
        this.arrived.push(...lines);
      });
    });
    async start(): Promise<void> {
      await new Promise<void>((resolve) => this.#server.listen(0, '127.0.0.1', resolve));
    }
    async step(input: TickInput): Promise<TickOutput> {
      // Let loopback deliver what the wrapper wrote before this tick, then record.
      await new Promise((resolve) => setTimeout(resolve, 4));
      this.afterTick[input.tick] = this.arrived.length;
      const hostPort = (this.#server.address() as net.AddressInfo).port;
      return {
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
      };
    }
    async stop(): Promise<void> {
      await new Promise<void>((resolve) => this.#server.close(() => resolve()));
    }
    /** The first tick after whose step line `index` had arrived. */
    tickOf(index: number): number {
      return this.afterTick.findIndex((count) => count > index);
    }
  }

  it('delivers each entry at the first tick start at or after its time, never before', async () => {
    const fakeFw = new FakeFirmware();
    const source = new ControlledSource(
      fakeFw,
      parseControlScript([
        { tUs: 1000, line: 'on-the-boundary' },
        { tUs: 100_900, line: 'between-ticks' },
        { tUs: 101_000, line: 'next-boundary' },
      ]),
    );
    await source.start(setup);
    for (let n = 0; n < 105; n += 1) await source.step(tick(n));
    await source.stop();
    expect(fakeFw.arrived).toEqual(['on-the-boundary', 'between-ticks', 'next-boundary']);
    expect(fakeFw.tickOf(0)).toBe(1); // 1000 µs: tick 1 starts at 1000
    expect(fakeFw.tickOf(1)).toBe(101); // 100 900 µs: not tick 100 (100 000), but tick 101
    expect(fakeFw.tickOf(2)).toBe(101);
  });
});

describe('9. a timeline that was not played in full fails the scenario', () => {
  let carDir = '';
  beforeAll(async () => {
    carDir = await mkdtemp(path.join(tmpdir(), 'rcsim-review1-cli-'));
    const { writeFile } = await import('node:fs/promises');
    await writeFile(path.join(carDir, 'car.json'), JSON.stringify(exampleCar));
    await writeFile(path.join(carDir, 'world.json'), JSON.stringify(testWorldFile()));
    await writeFile(
      path.join(carDir, 'late.json'),
      JSON.stringify([
        { tUs: 100_000, line: 'in time' },
        { tUs: 5_000_000, line: 'after the end' },
        { tUs: 200_000, port: 4444, line: 'to a port nobody listens on' },
      ]),
    );
    await writeFile(
      path.join(carDir, 'all.json'),
      JSON.stringify([{ tUs: 100_000, line: 'in time' }]),
    );
  });
  afterAll(() => rm(carDir, { recursive: true, force: true }));

  const rcsim = async (control: string): Promise<{ code: number; out: string }> => {
    let out = '';
    const code = await main(
      [
        'run',
        '--car',
        'car.json',
        '--world',
        'world.json',
        '--seconds',
        '1',
        '--firmware',
        built.control as string,
        '--control',
        control,
      ],
      { cwd: carDir, stdout: (t) => (out += t), stderr: () => undefined },
    );
    return { code, out };
  };

  it('exits 1 and names the entries and their ports', async () => {
    const r = await rcsim('late.json');
    expect(r.code).toBe(1);
    const result = JSON.parse(r.out) as { passed: boolean; end: { kind: string; message: string } };
    expect(result.passed).toBe(false);
    expect(result.end.kind).toBe('error');
    expect(result.end.message).toMatch(/2 of 3 timeline entries were never delivered/);
    expect(result.end.message).toMatch(/tUs 5000000 to port 3333 \(the run ended first\)/);
    expect(result.end.message).toMatch(
      /tUs 200000 to port 4444 \(the firmware never listened on it\)/,
    );
  });

  it('still passes when everything was delivered', async () => {
    const r = await rcsim('all.json');
    expect(r.code).toBe(0);
  });
});
