import { describe, expect, it } from 'vitest';
import { DEFAULT_CATALOG_ENTRIES } from './default-catalog.ts';
import { PartDefinition } from './part-definition.ts';

// The tests edit raw part files, including into invalid shapes, so they are untyped JSON.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type RawPart = Record<string, any>;

const base = (id: string): RawPart =>
  structuredClone(
    DEFAULT_CATALOG_ENTRIES.find((e) => e.source === `catalog/${id}.json`)?.data,
  ) as RawPart;

const messages = (data: unknown): string[] => {
  const result = PartDefinition.safeParse(data);
  return result.success ? [] : result.error.issues.map((i) => i.message);
};

describe('PartDefinition', () => {
  it('accepts every built-in part', () => {
    for (const entry of DEFAULT_CATALOG_ENTRIES) expect(messages(entry.data)).toEqual([]);
  });

  it('rejects pin names that differ only in case', () => {
    const part = base('sensor.hc-sr04');
    part.pins.push({ name: 'echo', kind: 'digital-out' });
    expect(messages(part).join()).toMatch(/clashes/);
  });

  it('requires a voltage on power-out pins', () => {
    const part = base('power.pololu-d24v22f5');
    delete part.pins.find((p: { name: string }) => p.name === 'VOUT').voltage;
    expect(messages(part).join()).toMatch(/power-out pin needs a voltage/);
  });

  it('allows a current budget only on power-out pins', () => {
    const part = base('sensor.hc-sr04');
    part.pins[0].maxCurrentMa = 10;
    expect(messages(part).join()).toMatch(/current budget/);
  });

  it('requires IN and OUT pins on a voltage divider', () => {
    const part = base('passive.divider-1k-2k');
    part.pins = part.pins.filter((p: { name: string }) => p.name !== 'OUT');
    expect(messages(part).join()).toMatch(/OUT/);
  });

  it('checks that I²C addressing names a real pin', () => {
    const part = base('sensor.vl53l0x-pololu');
    part.i2c.addressing.enablePin = 'NOPE';
    expect(messages(part).join()).toMatch(/NOPE/);
  });

  it('rejects unknown keys, so typos in part files are caught', () => {
    const part = base('sensor.hc-sr04');
    part.masG = 10;
    expect(messages(part).length).toBeGreaterThan(0);
  });

  it('rejects a behavior template with the wrong params', () => {
    const part = base('actuator.mg996r');
    part.behavior.params.pulseMinUs = 1600;
    expect(messages(part).join()).toMatch(/min < neutral < max/);
  });

  it('rejects a throttle curve that does not span 0..1', () => {
    const part = base('actuator.quicrun-1060-540');
    part.behavior.params.throttleCurve = [
      { input: 0, output: 0 },
      { input: 0.5, output: 1 },
    ];
    expect(messages(part).join()).toMatch(/throttleCurve/);
  });

  it('rejects a GPIO listed twice on a controller', () => {
    const part = base('controller.esp32-devkitc-v4');
    part.gpios.push({ ...part.gpios[0] });
    expect(messages(part).join()).toMatch(/listed twice/);
  });
});
