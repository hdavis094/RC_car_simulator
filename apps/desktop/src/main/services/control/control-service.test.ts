import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_PORT, FakeCar } from '@rcsim/control-protocol';
import type { RunInfo } from '../../../shared/ipc.ts';
import { Signal } from '../events.ts';
import { ControlService } from './control-service.ts';

function runStatus(hostPort: number, runId: string): RunInfo {
  return {
    runId,
    state: 'running',
    trackId: 'oval',
    speed: 1,
    seed: 1,
    end: null,
    netMappings: [{ proto: 'tcp', firmwarePort: DEFAULT_PORT, hostPort, bindAddress: '127.0.0.1' }],
  };
}

describe('ControlService', () => {
  const cars: FakeCar[] = [];
  const statuses = new Signal<[RunInfo]>();
  let control: ControlService;

  afterEach(async () => {
    control.dispose();
    for (const car of cars.splice(0)) await car.stop();
  });

  it('follows run mappings, reports actual wire traffic, and honors explicit targets', async () => {
    control = new ControlService({ onRunStatus: statuses.subscribe });
    const simCar = await FakeCar.start();
    const otherCar = await FakeCar.start();
    cars.push(simCar, otherCar);
    const lines: string[] = [];
    control.onRaw((line, direction) => lines.push(`${direction} ${line}`));

    expect(await control.setMode('auto')).toBe(false);
    const first = runStatus(simCar.port, 'first');
    statuses.emit(first);
    await expect.poll(() => lines.some((line) => line.startsWith('in {"t":"hello"'))).toBe(true);
    expect(await control.setMode('auto')).toBe(true);
    await expect.poll(() => simCar.state.mode).toBe('auto');
    expect(lines).toContain('out {"t":"mode","mode":"auto"}');

    const raw = '{ "t": "mode", "mode": "manual" }';
    expect(await control.sendRaw(raw)).toBe(true);
    await expect.poll(() => simCar.state.mode).toBe('manual');
    expect(lines).toContain(`out ${raw}`);

    statuses.emit({ ...first, state: 'ended', end: { kind: 'stopped' }, netMappings: [] });
    expect(await control.drive({ throttle: 1, steer: 0 })).toBe(false);
    await expect.poll(() => simCar.connected).toBe(false);
    statuses.emit(runStatus(otherCar.port, 'second'));
    await expect.poll(() => otherCar.connected).toBe(true);

    await control.connect({ kind: 'host', host: '127.0.0.1', port: simCar.port });
    await expect.poll(() => simCar.connected && !otherCar.connected).toBe(true);
    statuses.emit(runStatus(otherCar.port, 'third'));
    expect(await control.estop()).toBe(true);
    await expect.poll(() => simCar.state.estop).toBe(true);
    expect(otherCar.connected).toBe(false);
  });
});
