import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ActuatorSourceEnded } from '../api/actuator-source.ts';
import type { RunEnd } from '../api/run.ts';
import { testRun, testWorldFile } from '../run/test-support.ts';
import { main } from '../scenario/cli.ts';
import { exampleCar } from '@rcsim/schema';
import { fakeFirmware } from './fake-firmware.ts';
import { createFirmwareSource } from './firmware-source.ts';

// Waits in these tests are wall-clock and CI is slow: no test may time out before the longest wait it allows.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 300_000 });

let dir: string;
const fake = (name: string, body: string): Promise<string> => fakeFirmware(dir, name, body);
beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'rcsim-fake-fw-'));
});
afterAll(() => rm(dir, { recursive: true, force: true }));

async function endOf(binary: string, ticks = 3): Promise<RunEnd> {
  const source = createFirmwareSource({ binary, stallTimeoutMs: 5000 });
  try {
    const run = await testRun({ source });
    try {
      const result = await run.step(ticks);
      if (!result.end) throw new Error('the run did not end');
      return result.end;
    } finally {
      await run.stop();
    }
  } catch (error) {
    if (error instanceof ActuatorSourceEnded) return error.end;
    throw error;
  } finally {
    await source.stop();
  }
}

describe('a firmware that misbehaves', () => {
  it('well-behaved reference: answers every step (the harness itself works)', async () => {
    const binary = await fake(
      'good',
      `send(hello); await receive();
       for (;;) { const s = await receive(); if (s.type === 'BYE') process.exit(0);
         send({ type: 'STEP_DONE', tick: s.tick, pwm: [], gpioWrites: [], serialTx: new Uint8Array(), netEvents: [], logs: [] }); }`,
    );
    const source = createFirmwareSource({ binary });
    const run = await testRun({ source });
    expect((await run.step(20)).status).toBe('running');
    await run.stop();
  });

  it('is refused for speaking another protocol version, with a clear reason', async () => {
    const binary = await fake(
      'old',
      `send({ ...hello, protocolVersion: 2 }); await receive(); await new Promise((r) => setTimeout(r, 5000));`,
    );
    const end = await endOf(binary);
    expect(end).toMatchObject({ kind: 'error' });
    expect(JSON.stringify(end)).toMatch(/sim-protocol 2.*speaks 1/);
  });

  it('is ended as an error for answering the wrong tick', async () => {
    const binary = await fake(
      'wrong-tick',
      `send(hello); await receive(); const s = await receive();
       send({ type: 'STEP_DONE', tick: s.tick + 5, pwm: [], gpioWrites: [], serialTx: new Uint8Array(), netEvents: [], logs: [] });
       await new Promise((r) => setTimeout(r, 5000));`,
    );
    const end = await endOf(binary);
    expect(end).toMatchObject({ kind: 'error' });
    expect(JSON.stringify(end)).toMatch(/STEP_DONE 5 does not answer STEP 0/);
  });

  it('is ended for sending a frame that is not valid, and told so', async () => {
    const binary = await fake(
      'garbage',
      `send(hello); await receive(); await receive();
       socket.write(Buffer.from([1, 0, 0, 0, 0x7f]));
       const bye = await receive(); console.error('sim said', bye.type, bye.reason);
       await new Promise((r) => setTimeout(r, 200));`,
    );
    // SPEC.md: a malformed frame gets BYE(malformed) and the run ends as an error.
    const end = await endOf(binary);
    expect(end.kind).toBe('error');
    expect(JSON.stringify(end)).toMatch(/unknown message type/);
  });

  it('is ended for a message that does not belong (a second HELLO instead of STEP_DONE)', async () => {
    const binary = await fake(
      'confused',
      `send(hello); await receive(); await receive(); send(hello); await new Promise((r) => setTimeout(r, 5000));`,
    );
    const end = await endOf(binary);
    expect(end).toMatchObject({ kind: 'error' });
    expect(JSON.stringify(end)).toMatch(/unexpected HELLO.*waiting for STEP_DONE for tick 0/);
  });

  it('stalls the start when it never connects, after the startup timeout', async () => {
    const binary = await fake('mute', `await new Promise((r) => setTimeout(r, 10000));`);
    const source = createFirmwareSource({ binary, startupTimeoutMs: 300 });
    const err = await testRun({ source }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ActuatorSourceEnded);
    const end = (err as ActuatorSourceEnded).end;
    expect(end.kind).toBe('stalled');
    // the real elapsed time since spawn, not the nominal timeout
    // Node timers may fire ~1 ms early relative to performance.now().
    expect((end as { afterMs: number }).afterMs).toBeGreaterThanOrEqual(298);
    expect((end as { afterMs: number }).afterMs).toBeLessThan(5000);
  });

  it('crashes before saying hello: reported with its exit code', async () => {
    const binary = await fake('dead', `console.error('missing libfoo.so'); process.exit(127);`);
    const err = await testRun({ source: createFirmwareSource({ binary }) }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ActuatorSourceEnded);
    expect((err as ActuatorSourceEnded).end).toMatchObject({
      kind: 'crashed',
      exitCode: 127,
      stderrTail: ['missing libfoo.so'],
    });
  });

  it('is reported by the CLI when it fails before the first tick', async () => {
    const binary = await fake('dead-cli', `console.error('no such library'); process.exit(127);`);
    await writeFile(path.join(dir, 'car.json'), JSON.stringify(exampleCar));
    await writeFile(path.join(dir, 'world.json'), JSON.stringify(testWorldFile()));
    let err = '';
    const code = await main(
      ['run', '--car', 'car.json', '--world', 'world.json', '--seconds', '1', '--firmware', binary],
      { cwd: dir, stdout: () => undefined, stderr: (t) => (err += t) },
    );
    expect(code).toBe(1);
    expect(err).toMatch(/firmware failed to start: crashed \(exit code 127\)\nno such library/);
  });
});
