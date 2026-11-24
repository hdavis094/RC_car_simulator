import { defaultCatalog, exampleCar } from '@rcsim/schema';
import { ActuatorSourceEnded, trackLibrary, type ActuatorSource } from '@rcsim/sim-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HostAction, HostEvent } from './host-protocol.ts';
import { SimHost } from './sim-host.ts';

const start: Extract<HostAction, { type: 'start' }> = {
  type: 'start',
  info: {
    runId: 'run',
    trackId: 'oval',
    state: 'starting',
    speed: 1,
    seed: 1,
    end: null,
    netMappings: [],
  },
  car: exampleCar,
  catalog: defaultCatalog,
  track: trackLibrary.load('oval'),
  world: { name: 'Oval', schemaVersion: 1, trackId: 'oval', seed: 1, obstacles: [] },
  firmwarePath: '/unused',
  paused: false,
};

describe('SimHost', () => {
  let host: SimHost | undefined;
  afterEach(async () => {
    await host?.dispose();
    vi.useRealTimers();
  });

  it('paces ticks at the selected speed, yields snapshots and releases the source on stop', async () => {
    vi.useFakeTimers();
    const source: ActuatorSource = {
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      step: vi.fn(async () => ({
        pwm: [],
        gpioWrites: [],
        serialTx: new Uint8Array(),
        netEvents: [],
        logs: [],
      })),
    };
    const events: HostEvent[] = [];
    host = new SimHost((event) => events.push(event), {
      createSource: () => source,
      now: () => Date.now(),
    });

    await host.handle(start);
    await vi.advanceTimersByTimeAsync(100);
    expect(source.step).toHaveBeenCalledTimes(100);
    expect(events.filter((event) => event.type === 'snapshot')).toHaveLength(7);
    await host.handle({ type: 'setSpeed', speed: 2 });
    await vi.advanceTimersByTimeAsync(100);
    expect(source.step).toHaveBeenCalledTimes(300);
    await host.handle({ type: 'stop' });
    expect(source.stop).toHaveBeenCalledOnce();
    expect(events.at(-1)).toMatchObject({ type: 'status', info: { state: 'ended' } });
  });

  it('routes serial RX and TX, reports a crash and accepts the next run', async () => {
    const end = { kind: 'crashed', exitCode: 1, signal: null, stderrTail: [] } as const;
    const source: ActuatorSource = {
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      step: vi.fn(async ({ serialRx }) => {
        if (!serialRx.length) throw new ActuatorSourceEnded(end);
        return { pwm: [], gpioWrites: [], serialTx: serialRx, netEvents: [], logs: [] };
      }),
    };
    const events: HostEvent[] = [];
    host = new SimHost((event) => events.push(event), { createSource: () => source });
    const paused = { ...start, paused: true };
    await host.handle(paused);
    await host.handle({ type: 'sendSerial', text: 'hello' });
    await host.handle({ type: 'step', ticks: 1 });
    expect(events).toContainEqual({ type: 'serial', text: 'hello', tUs: 0 });
    await host.handle({ type: 'step', ticks: 1 });
    expect(events.at(-1)).toMatchObject({ type: 'status', info: { state: 'ended', end } });
    await expect(host.handle(paused)).resolves.toMatchObject({ state: 'paused' });
  });

  it('queues setNetFaults while paused so the latest edit takes effect on the next step, and supports reset', async () => {
    const receivedFaults: Array<unknown> = [];
    const source: ActuatorSource = {
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      step: vi.fn(async ({ netFaults }) => {
        receivedFaults.push(netFaults);
        return { pwm: [], gpioWrites: [], serialTx: new Uint8Array(), netEvents: [], logs: [] };
      }),
    };
    host = new SimHost(() => {}, { createSource: () => source });

    await expect(
      host.handle({
        type: 'setNetFaults',
        faults: { latencyUs: 1000, lossPpm: 0, dropout: false },
      }),
    ).rejects.toThrow('[rcsim:no-run]');

    await host.handle({ ...start, paused: true });
    expect(source.step).not.toHaveBeenCalled();

    // Two edits submitted while paused: neither steps early, and the latest wins on the next step.
    await host.handle({
      type: 'setNetFaults',
      faults: { latencyUs: 5_000, lossPpm: 10_000, dropout: false },
    });
    await host.handle({
      type: 'setNetFaults',
      faults: { latencyUs: 25_000, lossPpm: 150_000, dropout: true },
    });
    expect(source.step).not.toHaveBeenCalled();

    await host.handle({ type: 'step', ticks: 1 });
    await host.handle({ type: 'step', ticks: 1 });
    expect(receivedFaults).toEqual([
      { latencyUs: 25_000, lossPpm: 150_000, dropout: true },
      undefined,
    ]);

    // Reset while paused applies on the next step.
    await host.handle({
      type: 'setNetFaults',
      faults: { latencyUs: 0, lossPpm: 0, dropout: false },
    });
    await host.handle({ type: 'step', ticks: 1 });
    expect(receivedFaults).toEqual([
      { latencyUs: 25_000, lossPpm: 150_000, dropout: true },
      undefined,
      { latencyUs: 0, lossPpm: 0, dropout: false },
    ]);
  });

  it('delivers setNetFaults on the next tick while running', async () => {
    vi.useFakeTimers();
    const seenFaults: Array<unknown> = [];
    const source: ActuatorSource = {
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      step: vi.fn(async ({ netFaults }) => {
        if (netFaults) seenFaults.push(netFaults);
        return { pwm: [], gpioWrites: [], serialTx: new Uint8Array(), netEvents: [], logs: [] };
      }),
    };
    host = new SimHost(() => {}, { createSource: () => source, now: () => Date.now() });

    await host.handle(start);
    await host.handle({
      type: 'setNetFaults',
      faults: { latencyUs: 40_000, lossPpm: 50_000, dropout: false },
    });
    await vi.advanceTimersByTimeAsync(20);
    expect(seenFaults).toEqual([{ latencyUs: 40_000, lossPpm: 50_000, dropout: false }]);
    await host.handle({ type: 'stop' });
  });
});
