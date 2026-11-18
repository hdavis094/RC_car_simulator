// Regression tests for review round 5 of P1-H.
import { readFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { defaultCatalog, exampleCar } from '@rcsim/schema';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ActuatorSourceSetup, TickInput } from '../api/actuator-source.ts';
import { fakeFirmware } from './fake-firmware.ts';
import { createFirmwareSource } from './firmware-source.ts';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

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
  dir = await mkdtemp(path.join(tmpdir(), 'rcsim-review5-'));
});
afterAll(() => rm(dir, { recursive: true, force: true }));
const realWrite = net.Socket.prototype.write;
afterEach(() => {
  net.Socket.prototype.write = realWrite;
});

describe('1. startup is one budget from spawn to CONFIG sent', () => {
  const PHASE_MS = 400;
  const DEADLINE_MS = 900; // each phase fits; only the three together do not

  /**
   * A firmware that spends PHASE_MS before connecting and PHASE_MS before HELLO,
   * when `slow.flag` exists (so a first start can be quick and a restart slow).
   */
  async function slowFirmware(name: string): Promise<{ binary: string; flag: string }> {
    const flag = path.join(dir, `${name}.flag`);
    const binary = await fakeFirmware(
      dir,
      name,
      `await new Promise((r) => setTimeout(r, slow ? ${PHASE_MS} : 0));
       send(hello); await receive();
       for (;;) { const s = await receive(); if (s.type === 'BYE') process.exit(0); send(done(s.tick)); }`,
      `import { existsSync } from 'node:fs';
       const slow = existsSync(${JSON.stringify(flag)});
       await new Promise((r) => setTimeout(r, slow ? ${PHASE_MS} : 0));`,
    );
    return { binary, flag };
  }
  /** The bridge's CONFIG frame (type byte 2) reaches the firmware PHASE_MS late. */
  const delayConfig = (socketPath: () => string): void => {
    net.Socket.prototype.write = function (this: net.Socket, ...args: unknown[]) {
      const data = args[0] as Uint8Array | undefined;
      if ((this.server?.address() as unknown) === socketPath() && data?.[4] === 2) {
        setTimeout(() => realWrite.apply(this, args as never), PHASE_MS);
        return true;
      }
      return realWrite.apply(this, args as never);
    } as typeof net.Socket.prototype.write;
  };

  it('fails a start whose phases only add up past the deadline, reporting the elapsed time', async () => {
    const { binary, flag } = await slowFirmware('slow-start-sum');
    await writeFile(flag, '');
    const source = createFirmwareSource({ binary, startupTimeoutMs: DEADLINE_MS });
    delayConfig(() => source.socketPath);
    const started = Date.now();
    const err = await source.start(setup).catch((e: unknown) => e);
    const elapsed = Date.now() - started;
    expect(err).toMatchObject({ end: { kind: 'stalled' } });
    const afterMs = (err as { end: { afterMs: number } }).end.afterMs;
    expect(afterMs).toBeGreaterThanOrEqual(DEADLINE_MS - 10); // timers may fire a hair early
    expect(afterMs).toBeLessThan(DEADLINE_MS + 1500);
    expect(Math.abs(afterMs - elapsed)).toBeLessThan(300); // the real time, not the nominal one
    await source.stop();
  });

  it('fails a restart the same way', async () => {
    const { binary, flag } = await slowFirmware('slow-restart-sum');
    const source = createFirmwareSource({ binary, startupTimeoutMs: DEADLINE_MS });
    try {
      await source.start(setup); // quick: no flag yet
      await writeFile(flag, '');
      delayConfig(() => source.socketPath);
      const err = await source.restart().then(
        () => 'restarted',
        (e: unknown) => e,
      );
      expect(err).toMatchObject({ end: { kind: 'stalled' } });
      expect((err as { end: { afterMs: number } }).end.afterMs).toBeGreaterThanOrEqual(
        DEADLINE_MS - 10,
      );
    } finally {
      await source.stop();
    }
  });

  it('still starts when the same delays fit the deadline (the control case)', async () => {
    const { binary, flag } = await slowFirmware('slow-start-fits');
    await writeFile(flag, '');
    const source = createFirmwareSource({ binary, startupTimeoutMs: 10_000 });
    delayConfig(() => source.socketPath);
    try {
      await source.start(setup);
      await source.step(tick(0));
    } finally {
      await source.stop();
    }
  });
});

describe('2. the process group is signalled while the leader is alive', () => {
  it('stop() takes a healthy firmware’s helpers with it', async () => {
    const helperPid = path.join(dir, 'helper-stop.pid');
    const binary = await fakeFirmware(
      dir,
      'healthy-with-helper',
      `import { spawn } from 'node:child_process';
       import { writeFileSync } from 'node:fs';
       const helper = spawn('sleep', ['30'], { stdio: ['ignore', 'inherit', 'inherit'] });
       writeFileSync(${JSON.stringify(helperPid)}, String(helper.pid));
       send(hello); await receive();
       for (;;) { const s = await receive(); if (s.type === 'BYE') process.exit(0); send(done(s.tick)); }`,
    );
    const source = createFirmwareSource({ binary });
    await source.start(setup);
    await source.step(tick(0));
    const helper = Number(await readFile(helperPid, 'utf8'));
    try {
      expect(alive(helper)).toBe(true);
      await source.stop();
      expect(await until(() => !alive(helper), 5000)).toBe(true);
    } finally {
      if (alive(helper)) process.kill(helper, 'SIGKILL');
    }
  });
});
