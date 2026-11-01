import { describe, expect, it } from 'vitest';
import { generateCarConfigHeader } from './car-config-header.ts';
import { createCatalog } from './catalog.ts';
import { DEFAULT_CATALOG_ENTRIES, defaultCatalog } from './default-catalog.ts';
import { exampleCar } from './example-car.ts';

describe('generateCarConfigHeader', () => {
  const header = generateCarConfigHeader(exampleCar, defaultCatalog);

  it('pins the example car header', async () => {
    await expect(header).toMatchFileSnapshot('../examples/default-car.car_config.h');
  });

  it('has an include guard and a do-not-edit banner', () => {
    expect(header).toMatch(/^\/\/ car_config\.h: generated .* Do not edit/);
    expect(header).toContain('#ifndef CAR_CONFIG_H\n#define CAR_CONFIG_H\n');
    expect(header.trimEnd().endsWith('#endif  // CAR_CONFIG_H')).toBe(true);
  });

  it('names macros after instance ids and pins', () => {
    expect(header).toContain('#define TOF_LEFT_XSHUT_PIN 16\n');
    expect(header).toContain('#define TOF_LEFT_I2C_ADDR 0x30\n');
    expect(header).toContain('#define STEERING_SIGNAL_PIN 25\n');
  });

  it('emits a divider OUT pin, not its IN, and its resistor values', () => {
    expect(header).toContain('#define BATTERY_SENSE_OUT_PIN 35\n');
    expect(header).not.toContain('BATTERY_SENSE_IN_PIN');
    expect(header).toContain('#define BATTERY_SENSE_R1_OHM 100000\n');
  });

  it('gives byte-identical output for the same car, whatever the key order', () => {
    const reordered = structuredClone(exampleCar);
    for (const part of reordered.parts) {
      part.pins = Object.fromEntries(Object.entries(part.pins ?? {}).reverse());
    }
    expect(generateCarConfigHeader(reordered, defaultCatalog)).toBe(header);
    expect(generateCarConfigHeader(exampleCar, defaultCatalog)).toBe(header);
  });

  it('follows a pin through a voltage divider to its GPIO', () => {
    const car = structuredClone(exampleCar);
    car.parts.push(
      {
        instanceId: 'sonar',
        partId: 'sensor.hc-sr04',
        placement: { mount: 'front-centre' },
        pins: {
          VCC: { part: 'regulator', pin: 'VOUT' },
          TRIG: { gpio: 13 },
          ECHO: { part: 'echo_divider', pin: 'IN' },
        },
      },
      { instanceId: 'echo_divider', partId: 'passive.divider-1k-2k', pins: { OUT: { gpio: 34 } } },
    );
    const text = generateCarConfigHeader(car, defaultCatalog);
    expect(text).toContain('#define SONAR_TRIG_PIN 13\n');
    expect(text).toContain('#define SONAR_ECHO_PIN 34\n');
    expect(text).toContain('#define ECHO_DIVIDER_OUT_PIN 34\n');
  });

  it('keeps part names in one comment line, so they cannot inject code', () => {
    const servo = structuredClone(
      DEFAULT_CATALOG_ENTRIES.find((e) => e.source.includes('mg996r'))?.data,
    ) as { id: string; name: string };
    servo.id = 'custom.servo';
    servo.name = 'Servo\n#define CAR_WIFI_ENABLED 0';
    const catalog = createCatalog([{ source: 'parts/servo.json', data: servo }], defaultCatalog);
    const car = structuredClone(exampleCar);
    const steering = car.parts.find((p) => p.instanceId === 'steering');
    if (steering) steering.partId = 'custom.servo';
    const text = generateCarConfigHeader(car, catalog);
    expect(text).toContain('// steering: Servo #define CAR_WIFI_ENABLED 0 (custom.servo)');
    expect(text.match(/^#define CAR_WIFI_ENABLED/gm)).toHaveLength(1);
  });
});
