import { describe, expect, it } from 'vitest';
import { defaultCatalog } from './default-catalog.ts';
import { exampleCar } from './example-car.ts';
import { gpioAssignments } from './gpio-assignments.ts';

describe('gpioAssignments', () => {
  it('maps every GPIO-wired signal pin of the example car', () => {
    const pins = gpioAssignments(exampleCar, defaultCatalog);
    expect(pins['tof_left']).toEqual({ SDA: 21, SCL: 22, XSHUT: 16 });
    expect(pins['steering']).toEqual({ SIGNAL: 25 });
    expect(pins['battery_sense']).toEqual({ OUT: 35 });
    expect(pins['battery']).toEqual({});
  });

  it('follows a signal through a voltage divider', () => {
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
    expect(gpioAssignments(car, defaultCatalog)['sonar']).toEqual({ TRIG: 13, ECHO: 34 });
  });
});
