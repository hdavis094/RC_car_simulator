// Regression tests for review round 3 of P1-H.
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { ActuatorSource, ActuatorSourceSetup, TickInput } from '../api/actuator-source.ts';
import { testRun } from '../run/test-support.ts';
import { ControlledSource, parseControlScript } from './control-script.ts';
import { fakeFirmware } from './fake-firmware.ts';
import { createFirmwareSource } from './firmware-source.ts';
import { exampleCar, defaultCatalog } from '@rcsim/schema';

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

let dir = '';
beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'rcsim-review3-'));
});
afterAll(() => rm(dir, { recursive: true, force: true }));

const realWrite = net.Socket.prototype.write;
const realEmit = net.Socket.prototype.emit;
const realConnect = net.connect;
afterEach(() => {
  net.Socket.prototype.write = realWrite;
  net.Socket.prototype.emit = realEmit;
  net.connect = realConnect;
});

/** A stand-in firmware: announces a TCP server and counts what each connection receives. */
async function controlServer(): Promise<{
  inner: ActuatorSource;
  connections: { text: string }[];
  close(): Promise<void>;
}> {
  const connections: { text: string }[] = [];
  const peers: net.Socket[] = [];
  const server = net.createServer((socket) => {
    peers.push(socket);
    const connection = { text: '' };
    connections.push(connection);
    socket.setEncoding('utf8');
    socket.on('data', (d: string) => (connection.text += d));
    socket.on('error', () => undefined);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const hostPort = (server.address() as net.AddressInfo).port;
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
                hostPort,
                bindAddress: '127.0.0.1',
              },
            ]
          : [],
    }),
  };
  return {
    inner,
    connections,
    close: async () => {
      for (const p of peers) p.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

describe('1. a failed control write is never retried', () => {
  it('ends the run, naming the port and the tick, instead of replaying commands the firmware got', async () => {
    const fw = await controlServer();
    const entries = parseControlScript(
      Array.from({ length: 300 }, (_, i) => ({
        tUs: 1000,
        line: `${String(i).padStart(3, '0')}:${'x'.repeat(95)}`,
      })),
    ); // 300 lines of 100 bytes: one batch
    // The first connection's write gets ten complete lines to the firmware, then fails.
    let failed = false;
    net.Socket.prototype.write = function (this: net.Socket, ...args: unknown[]) {
      if (this.remotePort !== undefined && !failed) {
        failed = true;
        const [data, callback] = args as [string, (error?: Error) => void];
        realWrite.call(this, data.slice(0, 1000), 'utf8', () => {
          callback(new Error('read ECONNRESET'));
          this.destroy();
        });
        return true;
      }
      return realWrite.apply(this, args as never);
    } as typeof net.Socket.prototype.write;
    const source = new ControlledSource(fw.inner, entries, { stallTimeoutMs: 1000 });
    await source.start(setup);
    await source.step(tick(0));
    const err = await source.step(tick(1)).catch((e: unknown) => e);
    expect(err).toMatchObject({
      end: {
        kind: 'error',
        message: expect.stringMatching(
          /control connection to port 3333 reset during tick 1; delivery ambiguous/,
        ) as unknown,
      },
    });
    // A source that is stepped again anyway must not resend either.
    await expect(source.step(tick(2))).rejects.toMatchObject({ end: { kind: 'error' } });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fw.connections).toHaveLength(1); // no second connection
    expect(fw.connections[0]?.text.split('\n').filter(Boolean)).toHaveLength(10);
    expect(source.pending).toBe(300); // none counted as delivered
    await source.stop();
    await fw.close();
  });
});

describe('2. results do not depend on how frames are split into chunks', () => {
  type Split = (length: number) => number[];
  /** Seeded, so a failure reproduces. */
  const random = (seed: number): Split => {
    let state = seed;
    return (length) => {
      const sizes: number[] = [];
      for (let left = length; left > 0;) {
        state = (state * 1103515245 + 12345) & 0x7fffffff;
        const size = Math.min(left, 1 + (state % 7));
        sizes.push(size);
        left -= size;
      }
      return sizes;
    };
  };
  const splits: [string, Split | undefined, boolean][] = [
    ['one chunk', undefined, false],
    ['byte by byte, at once', (n) => Array<number>(n).fill(1), false],
    ['byte by byte, over time', (n) => Array<number>(n).fill(1), true],
    ['seeded random splits, at once', random(7), false],
    ['seeded random splits, over time', random(99), true],
  ];

  async function outcome(split: Split | undefined, spread: boolean) {
    // A valid tick (with serial output), then an invalid frame, in one write.
    const binary = await fakeFirmware(
      dir,
      `chunking-${Math.random().toString(36).slice(2)}`,
      `send(hello); await receive(); const s = await receive();
       socket.write(Buffer.concat([
         encodeFrame({ ...done(s.tick), serialTx: new TextEncoder().encode('valid tick\\n') }),
         Buffer.from([1, 0, 0, 0, 0x7f]),
       ]));
       await new Promise((r) => setTimeout(r, 30000));`,
    );
    const source = createFirmwareSource({ binary });
    if (split) {
      net.Socket.prototype.emit = function (this: net.Socket, name: string, ...args: unknown[]) {
        const chunk = args[0] as Uint8Array;
        if (name !== 'data' || (this.server?.address() as unknown) !== source.socketPath) {
          return realEmit.call(this, name, ...args);
        }
        let offset = 0;
        split(chunk.length).forEach((size, i) => {
          const piece = chunk.subarray(offset, offset + size);
          offset += size;
          if (spread) setTimeout(() => realEmit.call(this, 'data', piece), i);
          else realEmit.call(this, 'data', piece);
        });
        return true;
      } as typeof net.Socket.prototype.emit;
    }
    const run = await testRun({ source });
    const serial: string[] = [];
    run.on('serial', (bytes) => serial.push(new TextDecoder().decode(bytes)));
    try {
      const result = await run.step(3);
      return {
        ticks: result.ticks,
        status: result.status,
        clockUs: run.clock.nowUs,
        serial,
        end: result.end,
      };
    } finally {
      await run.stop();
      net.Socket.prototype.emit = realEmit;
    }
  }

  it.each(splits)(
    'is the same for %s',
    async (_name, split, spread) => {
      const result = await outcome(split, spread);
      // The valid answer stands: its tick completes and its serial output is emitted.
      // The invalid frame behind it ends the run at the next tick, and nothing after it counts.
      expect(result).toMatchObject({
        ticks: 1,
        status: 'ended',
        clockUs: 1000,
        serial: ['valid tick\n'],
        end: { kind: 'error', message: expect.stringMatching(/unknown message type/) as unknown },
      });
    },
    30_000,
  );
});

describe('3. stopping while a control connection is being made', () => {
  it('does not wait for the stall timeout', async () => {
    const fw = await controlServer();
    // A connection that never completes, as one to a host that doesn't answer.
    net.connect = ((): net.Socket => new net.Socket()) as unknown as typeof net.connect;
    const source = new ControlledSource(
      fw.inner,
      parseControlScript([{ tUs: 1000, line: 'test' }]),
      { stallTimeoutMs: 5000 },
    );
    await source.start(setup);
    await source.step(tick(0));
    const started = Date.now();
    const stepping = source.step(tick(1)).then(
      () => 'finished',
      (e: unknown) => e,
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    await source.stop();
    const result = await Promise.race([
      stepping,
      new Promise((resolve) => setTimeout(() => resolve('still waiting'), 2000)),
    ]);
    expect(result).toMatchObject({ end: { kind: 'finished' } });
    expect(Date.now() - started).toBeLessThan(1500);
    await fw.close();
  });
});
