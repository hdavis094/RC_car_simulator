import { once } from 'node:events';
import type { IncomingMessage } from 'node:http';
import { FakeCar } from '@rcsim/control-protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import type { RunInfo } from '../../../shared/ipc.ts';
import { ControlService } from '../control/control-service.ts';
import { Signal } from '../events.ts';
import { PhoneControlService } from './phone-control-service.ts';

const PROTOCOL = 'rcsim.control.v1';

function connect(url: URL, token = url.hash.slice(1), origin = url.origin): WebSocket {
  return new WebSocket(`ws://${url.host}/control`, [PROTOCOL, token], { origin });
}

async function rejected(url: URL, token: string, origin?: string): Promise<number | undefined> {
  const client = connect(url, token, origin);
  const [, response] = (await once(client, 'unexpected-response')) as [unknown, IncomingMessage];
  response.resume();
  client.on('error', () => {});
  client.terminate();
  return response.statusCode;
}

describe('PhoneControlService', () => {
  const statuses = new Signal<[RunInfo]>();
  let control: ControlService;
  let service: PhoneControlService;
  let car: FakeCar | undefined;

  afterEach(async () => {
    service?.dispose();
    control?.dispose();
    await car?.stop();
    car = undefined;
  });

  async function start(ms?: number): Promise<URL> {
    control = new ControlService({ onRunStatus: statuses.subscribe });
    service = new PhoneControlService(control, {
      bindAddress: '127.0.0.1',
      ...(ms === undefined ? {} : { sessionMs: ms }),
    });
    const info = await service.start();
    return new URL(info.urls[0] ?? '');
  }

  it('serves the phone page, requires the token and origin, and accepts one phone at a time', async () => {
    const url = await start();
    const response = await fetch(url);
    expect(response.ok).toBe(true);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.text()).toContain('Donkey Car Controller');
    expect(await rejected(url, 'wrong-token')).toBe(403);
    expect(await rejected(url, url.hash.slice(1), 'http://example.test')).toBe(403);

    const first = connect(url);
    await once(first, 'open');
    expect(first.protocol).toBe(PROTOCOL);
    expect(await rejected(url, url.hash.slice(1))).toBe(409);

    const closed = once(first, 'close');
    await service.stop();
    await closed;
    expect(await service.status()).toBeNull();
    await expect(fetch(url)).rejects.toThrow();
  });

  it('relays real control-protocol messages and releases drive on silence and disconnect', async () => {
    const url = await start();
    car = await FakeCar.start();
    const vehicle = car;
    await control.connect({ kind: 'host', host: '127.0.0.1', port: car.port });
    await expect.poll(() => vehicle.connected).toBe(true);
    const phone = connect(url);
    const telemetry: string[] = [];
    phone.on('message', (message) => telemetry.push(message.toString()));
    await once(phone, 'open');
    await expect.poll(() => telemetry.some((line) => line.includes('"telemetry"'))).toBe(true);

    phone.send(JSON.stringify({ t: 'drive', throttle: 0.5, steer: -0.7, seq: 1 }));
    await expect
      .poll(() =>
        vehicle.received.some((message) => message.t === 'drive' && message.throttle === 0.5),
      )
      .toBe(true);
    phone.send(JSON.stringify({ t: 'drive', throttle: 0.6, steer: 0, seq: 1 }));
    await expect
      .poll(() =>
        vehicle.received.some((message) => message.t === 'drive' && message.throttle === 0),
      )
      .toBe(true);
    expect(
      vehicle.received.some((message) => message.t === 'drive' && message.throttle === 0.6),
    ).toBe(false);

    phone.send(JSON.stringify({ t: 'drive', throttle: 0.4, steer: 0, seq: 2 }));
    await expect
      .poll(() =>
        vehicle.received.some((message) => message.t === 'drive' && message.throttle === 0.4),
      )
      .toBe(true);
    phone.close();
    await once(phone, 'close');
    await expect.poll(() => vehicle.state.throttle).toBe(0);

    const next = connect(url);
    await once(next, 'open');
    next.send(JSON.stringify({ t: 'estop' }));
    await expect.poll(() => vehicle.state.estop).toBe(true);
  });

  it('expires invitations and cancels a server that is still starting', async () => {
    const url = await start(25);
    await expect.poll(() => service.status()).toBeNull();
    await expect(fetch(url)).rejects.toThrow();
    const pending = service.start();
    service.dispose();
    await expect(pending).rejects.toThrow('Phone control stopped');
    expect(await service.status()).toBeNull();
  });
});
