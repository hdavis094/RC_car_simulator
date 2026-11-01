import { describe, expect, it } from 'vitest';
import { DEFAULT_CATALOG_ENTRIES } from './default-catalog.ts';
import { BEHAVIOR_TEMPLATES } from './behavior.ts';
import { PART_CATEGORIES, PartDefinition } from './part-definition.ts';

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

  it('requires regulator params to match the output pin', () => {
    const part = base('power.pololu-d24v22f5');
    part.behavior.params.outputV = 3.3;
    expect(messages(part).join()).toMatch(/matching its params/);
  });

  it('requires battery params to match the output pin', () => {
    const part = base('power.lipo-2s-5000');
    part.behavior.params.cells = 3;
    expect(messages(part).join()).toMatch(/matching its params/);
  });

  it('accepts battery currents whose product is not exact in floating point', () => {
    const part = base('power.lipo-2s-5000');
    part.behavior.params.capacityMah = 3300;
    part.behavior.params.maxContinuousC = 1.1;
    part.pins.find((p: { name: string }) => p.name === 'BAT+').maxCurrentMa = 3630;
    expect(messages(part)).toEqual([]);
  });

  it('allows maxInputV only on inputs', () => {
    const part = base('sensor.hc-sr04');
    part.pins.find((p: { name: string }) => p.name === 'ECHO').maxInputV = 5.5;
    expect(messages(part).join()).toMatch(/maxInputV/);
  });

  it('allows exactly two strap addresses', () => {
    const part = base('sensor.gy-521-mpu6050');
    part.i2c.addressing.addresses = [0x68, 0x69, 0x6a];
    expect(messages(part).length).toBeGreaterThan(0);
  });

  it('rejects a steering linkage ratio of 0 but allows a negative (reversed) one', () => {
    const part = base('chassis.traxxas-slash-2wd');
    part.steeringLinkageRatio = 0;
    expect(messages(part).length).toBeGreaterThan(0);
    part.steeringLinkageRatio = -0.7;
    expect(messages(part)).toEqual([]);
  });
});

describe('derived lists', () => {
  it('list every template and category in the unions', () => {
    expect(BEHAVIOR_TEMPLATES).toEqual([
      'distance-raycast',
      'imu',
      'servo',
      'esc-motor',
      'battery',
      'voltage-divider',
      'regulator',
    ]);
    expect(PART_CATEGORIES).toEqual([
      'controller',
      'chassis',
      'actuator',
      'sensor',
      'power',
      'passive',
    ]);
  });
});
