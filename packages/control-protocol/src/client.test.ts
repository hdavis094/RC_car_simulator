import { once } from 'node:events';
import { createServer } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { ControlClient } from './client.ts';
import { FakeCar } from './fake-car.ts';
import type { Telemetry } from './messages.ts';

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function until(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!predicate()) {
    if (performance.now() > deadline) throw new Error('timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function startCar(options: ConstructorParameters<typeof Object>[0] = {}): Promise<FakeCar> {
  const car = await FakeCar.start(options as never);
  cleanups.push(() => car.stop());
  return car;
}

function startClient(
  port: number,
  reconnect = { initialMs: 20, maxMs: 200, factor: 2 },
): ControlClient {
  const client = new ControlClient({ host: '127.0.0.1', port, reconnect });
  cleanups.push(() => client.close());
  client.connect();
  return client;
}

async function freePort(): Promise<number> {
  const server = createServer().listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  await new Promise((resolve) => server.close(resolve));
  if (address === null || typeof address === 'string') throw new Error('no port');
  return address.port;
}

describe('ControlClient against the fake car', () => {
  it('connects and receives hello', async () => {
    const car = await startCar({ name: 'Test car', fw: '1.2.3' });
    const client = startClient(car.port);
    const [hello] = await once(client, 'hello');
    expect(hello).toEqual({ t: 'hello', name: 'Test car', fw: '1.2.3', proto: 1 });
    expect(client.state).toBe('connected');
  });

  it('drives the car, clamping and numbering commands', async () => {
    const car = await startCar();
    const client = startClient(car.port);
    await once(client, 'hello');
    expect(client.drive({ throttle: 0.4, steer: -0.2 })).toBe(true);
    await until(() => car.state.throttle === 0.4);
    expect(car.state.steer).toBe(-0.2);

    client.drive({ throttle: 3, steer: Number.NaN });
    await until(() => car.state.throttle === 1);
    expect(car.state.steer).toBe(0);

    const seqs = car.received.flatMap((m) => (m.t === 'drive' ? [m.seq] : []));
    expect(seqs.length).toBeGreaterThanOrEqual(2);
    seqs.forEach((seq, i) => expect(seq).toBe(i));
  });

  it('does not queue commands while disconnected', async () => {
    const client = new ControlClient({ host: '127.0.0.1', port: await freePort() });
    cleanups.push(() => client.close());
    expect(client.estop()).toBe(false);
    expect(client.setMode('auto')).toBe(false);
  });

  it('emits telemetry at about 20 Hz, reflecting what the car applies', async () => {
    const car = await startCar();
    const client = startClient(car.port);
    await once(client, 'hello');
    client.drive({ throttle: 0.3, steer: 0.1 });
    await until(() => client.lastTelemetry?.throttle === 0.3);

    const samples: Telemetry[] = [];
    client.on('telemetry', (t) => samples.push(t));
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(samples.length).toBeGreaterThanOrEqual(7);
    expect(samples.length).toBeLessThanOrEqual(13);
    expect(samples.at(-1)).toMatchObject({
      mode: 'manual',
      estop: false,
      throttle: 0.3,
      steer: 0.1,
    });
  });

  it('ignores unknown fields and reports unknown types without disconnecting', async () => {
    const car = await startCar();
    const client = startClient(car.port);
    await once(client, 'hello');

    const unknown: string[] = [];
    client.on('unknown', ({ reason }) => unknown.push(reason));
    car.sendRaw(
      '{"t":"telemetry","ms":5,"mode":"auto","estop":false,"throttle":0,"steer":0,"lidar":[1,2]}',
    );
    car.sendRaw('{"t":"teleport","x":1}');
    car.sendRaw('not json');
    car.sendRaw(`{"t":"log","msg":"${'x'.repeat(5000)}"}`);
    car.log('still here');

    const [log] = await once(client, 'log');
    expect(log).toEqual({ t: 'log', msg: 'still here' });
    expect(client.lastTelemetry).not.toHaveProperty('lidar');
    // Over-long lines are reported as they are split off, so order is not guaranteed.
    expect(unknown).toHaveLength(3);
    expect(unknown).toEqual(
      expect.arrayContaining([
        'invalid or unknown message "teleport"',
        'not JSON',
        expect.stringMatching(/over the limit/),
      ]),
    );
    expect(client.state).toBe('connected');
  });

  it('reconnects with backoff after the car drops it, and resumes the held command', async () => {
    const car = await startCar();
    const client = startClient(car.port);
    await once(client, 'hello');
    client.drive({ throttle: 0.5, steer: 0 });
    await until(() => car.state.throttle === 0.5);

    const states: string[] = [];
    client.on('state', (s) => states.push(s));
    car.dropClient();
    await once(client, 'hello');
    expect(states).toEqual(['waiting', 'connecting', 'connected']);
    await until(
      () => car.received.filter((m) => m.t === 'drive').length > 0 && car.state.throttle === 0.5,
    );
  });

  it('keeps retrying, with growing delays, until the car appears', async () => {
    const port = await freePort();
    const client = startClient(port, { initialMs: 20, maxMs: 80, factor: 2 });
    const attempts: number[] = [];
    client.on('state', (s) => {
      if (s === 'connecting') attempts.push(performance.now());
    });
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(client.state).not.toBe('connected');
    const gaps = attempts.slice(1).map((t, i) => t - (attempts[i] ?? t));
    expect(gaps.length).toBeGreaterThanOrEqual(3);
    expect(gaps[0]).toBeLessThan(gaps[2] ?? Infinity);
    expect(Math.max(...gaps)).toBeLessThan(80 + 60);

    await startCar({ port });
    await once(client, 'hello');
    expect(client.state).toBe('connected');
  });
});

describe('ControlClient edge cases', () => {
  it('refuses drive while disconnected and after close, without holding it', async () => {
    const car = await startCar();
    const client = new ControlClient({ host: '127.0.0.1', port: car.port });
    cleanups.push(() => client.close());
    expect(client.drive({ throttle: 0.9, steer: 0 })).toBe(false);
    client.connect();
    await once(client, 'hello');
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(car.received.filter((m) => m.t === 'drive')).toEqual([]);
    client.close();
    expect(client.drive({ throttle: 0.9, steer: 0 })).toBe(false);
  });

  it('leaves no retry timer when close() is called on entering waiting', async () => {
    const client = new ControlClient({
      host: '127.0.0.1',
      port: await freePort(),
      reconnect: { initialMs: 60_000, maxMs: 60_000, factor: 1 },
    });
    client.on('error', () => {});
    client.on('state', (s) => {
      if (s === 'waiting') client.close();
    });
    client.connect();
    await until(() => client.state === 'closed');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(client.state).toBe('closed');
    // No live timer: the client holds no handle that would keep the process up.
    const handles = (
      process as unknown as { getActiveResourcesInfo(): string[] }
    ).getActiveResourcesInfo();
    expect(handles.filter((h) => h === 'Timeout').length).toBeLessThan(5);
  });

  it('honours close() called from a state listener', async () => {
    const car = await startCar();
    const client = new ControlClient({ host: '127.0.0.1', port: car.port });
    client.on('state', (s) => {
      if (s === 'connecting') client.close();
    });
    client.connect();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(client.state).toBe('closed');
    expect(car.connected).toBe(false);
  });

  it('does not hang on a host that never answers', async () => {
    // Non-routable: the attempt either times out (connectTimeoutMs) or fails
    // fast, depending on the host's network; either way the client moves on.
    const client = new ControlClient({
      host: '10.255.255.1',
      port: 3333,
      connectTimeoutMs: 100,
      reconnect: { initialMs: 1000, maxMs: 1000, factor: 1 },
    });
    cleanups.push(() => client.close());
    client.on('error', () => {});
    client.on('warning', () => {});
    client.connect();
    await until(() => client.state === 'waiting', 1500);
  });

  it('reconnects when the car goes silent', async () => {
    const car = await startCar({ telemetryIntervalMs: 10_000 });
    const client = new ControlClient({
      host: '127.0.0.1',
      port: car.port,
      silenceTimeoutMs: 150,
      reconnect: { initialMs: 20, maxMs: 20, factor: 1 },
    });
    cleanups.push(() => client.close());
    const warnings: string[] = [];
    client.on('warning', (w) => warnings.push(w));
    client.connect();
    await once(client, 'hello');
    await once(client, 'hello');
    expect(warnings.join()).toMatch(/no data/);
  });

  it('warns about a car speaking another protocol version', async () => {
    const car = await startCar();
    const client = startClient(car.port);
    await once(client, 'hello');
    const warning = once(client, 'warning');
    car.sendRaw('{"t":"hello","name":"x","fw":"9","proto":2}');
    const [message] = await warning;
    expect(message).toMatch(/protocol 2/);
  });
});

describe('failsafe timing', () => {
  it('is not extended by mode messages', async () => {
    const car = await startCar();
    const client = startClient(car.port);
    await once(client, 'hello');
    client.drive({ throttle: 0.7, steer: 0 });
    await until(() => car.state.throttle === 0.7);
    client.releaseDrive();
    const ticker = setInterval(() => client.setMode('manual'), 100);
    cleanups.push(() => clearInterval(ticker));
    const [sinceLastDriveMs] = (await once(car, 'failsafe')) as [number];
    expect(sinceLastDriveMs).toBeLessThan(650);
    expect(car.state.throttle).toBe(0);
  });

  it('stays off while the client holds a drive command', async () => {
    const car = await startCar();
    const client = startClient(car.port);
    await once(client, 'hello');
    let fired = false;
    car.on('failsafe', () => (fired = true));
    client.drive({ throttle: 0.4, steer: 0 });
    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(fired).toBe(false);
    expect(car.state.throttle).toBe(0.4);
  });

  it('stops the car 500 ms after the last drive command in manual mode', async () => {
    const car = await startCar();
    const client = startClient(car.port);
    await once(client, 'hello');
    client.drive({ throttle: 0.4, steer: 0.3 });
    await until(() => car.state.throttle === 0.4);
    client.releaseDrive();

    const [sinceLastDriveMs] = (await once(car, 'failsafe')) as [number];
    expect(sinceLastDriveMs).toBeGreaterThanOrEqual(495);
    expect(sinceLastDriveMs).toBeLessThan(650);
    expect(car.state).toMatchObject({ throttle: 0, steer: 0, failsafe: true });
    await until(() => client.lastTelemetry?.throttle === 0);

    client.drive({ throttle: 0.2, steer: 0 });
    await until(() => car.state.throttle === 0.2);
    expect(car.state.failsafe).toBe(false);
  });

  it('fires when the connection drops, as on a Wi-Fi dropout', async () => {
    const car = await startCar();
    const client = startClient(car.port, { initialMs: 5000, maxMs: 5000, factor: 1 });
    await once(client, 'hello');
    client.drive({ throttle: 0.4, steer: 0 });
    await until(() => car.state.throttle === 0.4);
    car.dropClient();
    await once(car, 'failsafe');
    expect(car.state.throttle).toBe(0);
  });

  it('does not apply in auto mode', async () => {
    const car = await startCar();
    const client = startClient(car.port);
    await once(client, 'hello');
    client.setMode('auto');
    await until(() => car.state.mode === 'auto');
    let fired = false;
    car.on('failsafe', () => (fired = true));
    await new Promise((resolve) => setTimeout(resolve, 650));
    expect(fired).toBe(false);
  });
});

describe('e-stop', () => {
  it('latches until a mode command, ignoring drive meanwhile', async () => {
    const car = await startCar();
    const client = startClient(car.port);
    await once(client, 'hello');
    client.drive({ throttle: 0.6, steer: 0 });
    await until(() => car.state.throttle === 0.6);

    client.estop();
    await until(() => car.state.estop);
    expect(car.state.throttle).toBe(0);
    client.drive({ throttle: 0.6, steer: 0 });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(car.state.throttle).toBe(0);
    await until(() => client.lastTelemetry?.estop === true);

    client.setMode('manual');
    await until(() => car.state.throttle === 0.6);
    expect(car.state.estop).toBe(false);
  });
});
