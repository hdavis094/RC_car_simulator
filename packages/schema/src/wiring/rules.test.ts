import { describe, expect, it } from 'vitest';
import type { Car, Part } from '../car.ts';
import { createCatalog, type Catalog } from '../catalog.ts';
import { DEFAULT_CATALOG_ENTRIES, defaultCatalog } from '../default-catalog.ts';
import { exampleCar } from '../example-car.ts';
import type { Issue, WiringRuleId } from './issue.ts';
import { canRun, checkWiring } from './rules.ts';

/** A copy of the example car with `edit` applied. */
function carWith(edit: (car: Car, part: (id: string) => Part) => void): Car {
  const car = structuredClone(exampleCar);
  const part = (id: string): Part => {
    const found = [car.controller, ...car.parts].find((p) => p.instanceId === id);
    if (!found) throw new Error(`example car has no part "${id}"`);
    return found;
  };
  edit(car, part);
  return car;
}

const issuesOf = (car: Car, rule: WiringRuleId, catalog: Catalog = defaultCatalog): Issue[] =>
  checkWiring(car, catalog).filter((i) => i.rule === rule);

/** The default catalog plus a GY-521 copy whose INT pin is named LEFT_XSHUT. */
const clashCatalog = createCatalog(
  [
    {
      source: 'parts/odd-imu.json',
      data: (() => {
        const imu = structuredClone(
          DEFAULT_CATALOG_ENTRIES.find((e) => e.source.includes('gy-521'))?.data,
        ) as { id: string; pins: { name: string }[] };
        imu.id = 'custom.odd-imu';
        for (const pin of imu.pins) if (pin.name === 'INT') pin.name = 'LEFT_XSHUT';
        return imu;
      })(),
    },
  ],
  defaultCatalog,
);

const remove = (part: Part, pin: string): void => {
  const { [pin]: _removed, ...rest } = part.pins ?? {};
  part.pins = rest;
};

const sonar = (pins: Part['pins']): Part => ({
  instanceId: 'sonar',
  partId: 'sensor.hc-sr04',
  placement: { mount: 'front-centre', offsetMm: { x: 0, y: 20, z: 0 } },
  pins: { VCC: { part: 'regulator', pin: 'VOUT' }, TRIG: { gpio: 13 }, ...pins },
});

const echoDivider: Part = {
  instanceId: 'echo_divider',
  partId: 'passive.divider-1k-2k',
  pins: { OUT: { gpio: 34 } },
};

interface RuleCase {
  readonly rule: WiringRuleId;
  readonly severity: Issue['severity'];
  readonly passes: Record<string, Car>;
  readonly fails: Record<string, Car>;
  readonly catalog?: Catalog;
}

const cases: RuleCase[] = [
  {
    rule: 'reference',
    severity: 'error',
    passes: { 'the example car': exampleCar },
    fails: {
      'an unknown part definition': carWith((car) => {
        car.parts.push({ instanceId: 'mystery', partId: 'sensor.does-not-exist' });
      }),
      'a pin the part does not have': carWith((_, part) => {
        part('steering').pins = { ...part('steering').pins, PWM: { gpio: 13 } };
      }),
      'a GPIO the controller does not have': carWith((_, part) => {
        part('steering').pins = { ...part('steering').pins, SIGNAL: { gpio: 24 } };
      }),
      'a wire to a missing part': carWith((_, part) => {
        part('imu').pins = { ...part('imu').pins, VCC: { part: 'ghost', pin: 'VOUT' } };
      }),
      'an I²C address on a part without I²C': carWith((_, part) => {
        part('steering').i2cAddress = 0x40;
      }),
      'a second controller in parts': carWith((car) => {
        car.parts.push({ instanceId: 'esp32_b', partId: 'controller.esp32-devkitc-v4' });
      }),
    },
  },
  {
    rule: 'pin-kind-mismatch',
    severity: 'error',
    passes: { 'the example car': exampleCar },
    fails: {
      'a power pin on a GPIO': carWith((_, part) => {
        part('tof_left').pins = { ...part('tof_left').pins, VIN: { gpio: 4 } };
      }),
      'a signal pin on a power rail': carWith((_, part) => {
        part('steering').pins = {
          ...part('steering').pins,
          SIGNAL: { part: 'battery', pin: 'BAT+' },
        };
      }),
    },
  },
  {
    rule: 'pin-conflict',
    severity: 'error',
    passes: { 'four I²C parts sharing SDA and SCL': exampleCar },
    fails: {
      'two PWM outputs on one GPIO': carWith((_, part) => {
        part('steering').pins = { ...part('steering').pins, SIGNAL: { gpio: 26 } };
      }),
      'SDA and SCL on one GPIO': carWith((_, part) => {
        part('imu').pins = { ...part('imu').pins, SCL: { gpio: 21 } };
      }),
      'one SDA GPIO shared by two buses with different SCLs': carWith((car) => {
        car.parts.push({
          instanceId: 'imu_b',
          partId: 'sensor.gy-521-mpu6050',
          placement: { mount: 'rear' },
          pins: { VCC: { part: 'esp32', pin: '3V3' }, SDA: { gpio: 21 }, SCL: { gpio: 23 } },
        });
      }),
    },
  },
  {
    rule: 'rail-conflict',
    severity: 'error',
    passes: { 'the example car': exampleCar },
    fails: {
      'two power outputs on one rail': carWith((_, part) => {
        part('esc').pins = { ...part('esc').pins, BEC: { part: 'esp32', pin: '5V' } };
      }),
    },
  },
  {
    rule: 'input-only-output',
    severity: 'error',
    passes: { 'an analog reading on input-only GPIO 35': exampleCar },
    fails: {
      'a servo signal on input-only GPIO 34': carWith((_, part) => {
        part('steering').pins = { ...part('steering').pins, SIGNAL: { gpio: 34 } };
      }),
      'XSHUT on input-only GPIO 39': carWith((_, part) => {
        part('tof_left').pins = { ...part('tof_left').pins, XSHUT: { gpio: 39 } };
      }),
    },
  },
  {
    rule: 'flash-pin',
    severity: 'error',
    passes: { 'the example car': exampleCar },
    fails: {
      'GPIO 6 (flash clock)': carWith((_, part) => {
        part('steering').pins = { ...part('steering').pins, SIGNAL: { gpio: 6 } };
      }),
      'GPIO 11 (flash command)': carWith((_, part) => {
        part('tof_left').pins = { ...part('tof_left').pins, XSHUT: { gpio: 11 } };
      }),
    },
  },
  {
    rule: 'uart0-pin',
    severity: 'error',
    passes: { 'the example car': exampleCar },
    fails: {
      'GPIO 1 (UART0 TX)': carWith((_, part) => {
        part('steering').pins = { ...part('steering').pins, SIGNAL: { gpio: 1 } };
      }),
      'GPIO 3 (UART0 RX)': carWith((_, part) => {
        part('tof_left').pins = { ...part('tof_left').pins, XSHUT: { gpio: 3 } };
      }),
    },
  },
  {
    rule: 'strapping-pin',
    severity: 'warning',
    passes: { 'the example car': exampleCar },
    fails: {
      'GPIO 2': carWith((_, part) => {
        part('steering').pins = { ...part('steering').pins, SIGNAL: { gpio: 2 } };
      }),
      'GPIO 12': carWith((_, part) => {
        part('tof_left').pins = { ...part('tof_left').pins, XSHUT: { gpio: 12 } };
      }),
    },
  },
  {
    rule: 'no-adc',
    severity: 'error',
    passes: {
      'battery sense on ADC1 GPIO 35': exampleCar,
      'a divided digital echo on non-ADC GPIO 23': carWith((car) => {
        car.parts.push(sonar({ ECHO: { part: 'echo_divider', pin: 'IN' } }), {
          ...echoDivider,
          pins: { OUT: { gpio: 23 } },
        });
      }),
    },
    fails: {
      'battery sense on GPIO 23': carWith((_, part) => {
        part('battery_sense').pins = { ...part('battery_sense').pins, OUT: { gpio: 23 } };
      }),
    },
  },
  {
    rule: 'adc2-wifi',
    severity: 'error',
    passes: {
      'battery sense on ADC1 with Wi-Fi': exampleCar,
      'battery sense on ADC2 without Wi-Fi': carWith((car, part) => {
        car.wifi = false;
        part('battery_sense').pins = { ...part('battery_sense').pins, OUT: { gpio: 27 } };
      }),
      'a divided digital echo on ADC2 GPIO 27 with Wi-Fi': carWith((car) => {
        car.parts.push(sonar({ ECHO: { part: 'echo_divider', pin: 'IN' } }), {
          ...echoDivider,
          pins: { OUT: { gpio: 27 } },
        });
      }),
    },
    fails: {
      'battery sense on ADC2 with Wi-Fi': carWith((_, part) => {
        part('battery_sense').pins = { ...part('battery_sense').pins, OUT: { gpio: 27 } };
      }),
    },
  },
  {
    rule: 'level-mismatch',
    severity: 'error',
    passes: {
      'ToF sensors powered from 3V3': exampleCar,
      'HC-SR04 echo through a 1k/2k divider': carWith((car) => {
        car.parts.push(sonar({ ECHO: { part: 'echo_divider', pin: 'IN' } }), echoDivider);
      }),
    },
    fails: {
      'HC-SR04 5 V echo straight into GPIO 34': carWith((car) => {
        car.parts.push(sonar({ ECHO: { gpio: 34 } }));
      }),
      '6 V from the BEC on the MPU6050 AD0 input': carWith((_, part) => {
        part('imu').i2cAddress = 0x69;
        part('imu').pins = { ...part('imu').pins, AD0: { part: 'esc', pin: 'BEC' } };
      }),
      'a ToF breakout powered from 5 V shifts I²C to 5 V': carWith((_, part) => {
        part('tof_left').pins = {
          ...part('tof_left').pins,
          VIN: { part: 'regulator', pin: 'VOUT' },
        };
      }),
    },
  },
  {
    rule: 'supply-voltage',
    severity: 'error',
    passes: { 'the example car': exampleCar },
    fails: {
      'a ToF breakout on the battery': carWith((_, part) => {
        part('tof_left').pins = { ...part('tof_left').pins, VIN: { part: 'battery', pin: 'BAT+' } };
      }),
      'an HC-SR04 on 3V3': carWith((car) => {
        car.parts.push(
          {
            ...sonar({ ECHO: { part: 'echo_divider', pin: 'IN' } }),
            pins: {
              VCC: { part: 'esp32', pin: '3V3' },
              TRIG: { gpio: 13 },
              ECHO: { part: 'echo_divider', pin: 'IN' },
            },
          },
          echoDivider,
        );
      }),
    },
  },
  {
    rule: 'rail-over-budget',
    severity: 'error',
    passes: { 'the example car': exampleCar },
    fails: {
      'three servos on the 500 mA 3V3 pin': carWith((car) => {
        for (const [n, gpio] of [
          [1, 13],
          [2, 14],
          [3, 27],
        ] as const) {
          car.parts.push({
            instanceId: `extra_servo_${n}`,
            partId: 'actuator.mg996r',
            pins: { 'V+': { part: 'esp32', pin: '3V3' }, SIGNAL: { gpio } },
          });
        }
      }),
    },
  },
  {
    rule: 'i2c-incomplete',
    severity: 'error',
    passes: { 'the example car': exampleCar },
    fails: {
      'SDA without SCL': carWith((_, part) => {
        const { SCL: _scl, ...rest } = part('tof_left').pins ?? {};
        part('tof_left').pins = rest;
      }),
    },
  },
  {
    rule: 'i2c-address-invalid',
    severity: 'error',
    passes: {
      'MPU6050 at its default 0x68': exampleCar,
      'MPU6050 at 0x69 with AD0 high': carWith((_, part) => {
        part('imu').i2cAddress = 0x69;
        part('imu').pins = { ...part('imu').pins, AD0: { part: 'esp32', pin: '3V3' } };
      }),
    },
    fails: {
      'MPU6050 at 0x6A': carWith((_, part) => {
        part('imu').i2cAddress = 0x6a;
      }),
    },
  },
  {
    rule: 'i2c-address-unreachable',
    severity: 'error',
    passes: {
      'ToF sensors re-addressed with XSHUT on GPIOs': exampleCar,
      'one of three ToF sensors without XSHUT, moved first': carWith((_, part) => {
        remove(part('tof_left'), 'XSHUT');
      }),
      'a lone ToF sensor re-addressed without XSHUT': carWith((car, part) => {
        car.parts = car.parts.filter(
          (p) => p.instanceId !== 'tof_centre' && p.instanceId !== 'tof_right',
        );
        remove(part('tof_left'), 'XSHUT');
      }),
      'MPU6050 at 0x69 with AD0 high': carWith((_, part) => {
        part('imu').i2cAddress = 0x69;
        part('imu').pins = { ...part('imu').pins, AD0: { part: 'esp32', pin: '3V3' } };
      }),
    },
    fails: {
      'two of three ToF sensors without XSHUT': carWith((_, part) => {
        remove(part('tof_left'), 'XSHUT');
        remove(part('tof_centre'), 'XSHUT');
      }),
      'the ToF sensor without XSHUT stays at the boot address': carWith((_, part) => {
        remove(part('tof_left'), 'XSHUT');
        delete part('tof_left').i2cAddress;
      }),
      'MPU6050 at 0x69 with AD0 open': carWith((_, part) => {
        part('imu').i2cAddress = 0x69;
      }),
    },
  },
  {
    rule: 'i2c-address-clash',
    severity: 'error',
    passes: {
      'distinct addresses on one bus': exampleCar,
      'equal addresses on separate buses': carWith((_, part) => {
        part('tof_right').i2cAddress = 0x30;
        part('tof_right').pins = {
          ...part('tof_right').pins,
          SDA: { gpio: 32 },
          SCL: { gpio: 33 },
        };
      }),
    },
    fails: {
      'two ToF sensors at 0x30': carWith((_, part) => {
        part('tof_right').i2cAddress = 0x30;
      }),
      'three ToF sensors left at the boot address': carWith((_, part) => {
        for (const id of ['tof_left', 'tof_centre', 'tof_right']) delete part(id).i2cAddress;
      }),
    },
  },
  {
    rule: 'unconnected-pin',
    severity: 'warning',
    passes: { 'the example car': exampleCar },
    fails: {
      'a servo without power': carWith((_, part) => {
        const { 'V+': _power, ...rest } = part('steering').pins ?? {};
        part('steering').pins = rest;
      }),
    },
  },
  {
    rule: 'placement',
    severity: 'error',
    passes: { 'the example car': exampleCar },
    fails: {
      'a ToF sensor with no placement': carWith((_, part) => {
        delete part('tof_left').placement;
      }),
      'a mount point the chassis lacks': carWith((_, part) => {
        part('tof_left').placement = { mount: 'bumper' };
      }),
    },
  },
  {
    rule: 'macro-clash',
    severity: 'error',
    catalog: clashCatalog,
    passes: { 'the example car': exampleCar },
    fails: {
      'instance "tof" with pin LEFT_XSHUT next to tof_left.XSHUT': carWith((car) => {
        car.parts.push({
          instanceId: 'tof',
          partId: 'custom.odd-imu',
          placement: { mount: 'rear' },
          pins: {
            VCC: { part: 'esp32', pin: '3V3' },
            SDA: { gpio: 32 },
            SCL: { gpio: 33 },
            LEFT_XSHUT: { gpio: 4 },
          },
        });
      }),
    },
  },
];

describe('the example car', () => {
  it('passes the wiring rules with no errors and no warnings', () => {
    const issues = checkWiring(exampleCar, defaultCatalog);
    expect(issues).toEqual([]);
    expect(canRun(issues)).toBe(true);
  });
});

describe.each(cases)('wiring rule $rule', ({ rule, severity, passes, fails, catalog }) => {
  it.each(Object.entries(passes))('passes: %s', (_, car) => {
    expect(issuesOf(car, rule, catalog)).toEqual([]);
  });

  it.each(Object.entries(fails))('fails: %s', (_, car) => {
    const found = issuesOf(car, rule, catalog);
    expect(found.map((i) => i.severity)).toContain(severity);
    for (const i of found) {
      expect(i.message.length).toBeGreaterThan(0);
      expect(i.refs.length).toBeGreaterThan(0);
    }
  });
});

describe('wiring rule rail-over-budget, peak current', () => {
  it('warns when only the peak load exceeds the budget: four servos on the 3 A BEC', () => {
    const car = carWith((c) => {
      for (const [n, gpio] of [
        [1, 13],
        [2, 14],
        [3, 27],
      ] as const) {
        c.parts.push({
          instanceId: `extra_servo_${n}`,
          partId: 'actuator.mg996r',
          pins: { 'V+': { part: 'esc', pin: 'BEC' }, SIGNAL: { gpio } },
        });
      }
    });
    const found = issuesOf(car, 'rail-over-budget');
    expect(found).toHaveLength(1);
    expect(found[0]?.severity).toBe('warning');
    expect(found[0]?.refs).toEqual([{ part: 'esc', pin: 'BEC' }]);
  });
});

describe('level-mismatch refs', () => {
  it('names only the pins that drive the GPIO, not inputs on it', () => {
    const car = carWith((c, part) => {
      c.parts.push(sonar({ ECHO: { gpio: 4 } }));
      part('steering').pins = { ...part('steering').pins, SIGNAL: { gpio: 4 } };
    });
    const intoGpio = issuesOf(car, 'level-mismatch').find((i) => i.refs.some((r) => 'gpio' in r));
    expect(intoGpio?.refs).toContainEqual({ part: 'sonar', pin: 'ECHO' });
    expect(intoGpio?.message).not.toMatch(/steering/);
  });
});

describe('checkWiring', () => {
  it('covers every rule id with a case', async () => {
    const { WiringRuleId } = await import('./issue.ts');
    expect(new Set(cases.map((c) => c.rule))).toEqual(new Set(WiringRuleId.options));
  });

  it('is deterministic', () => {
    const car = carWith((c) => {
      c.parts.push(sonar({ ECHO: { gpio: 34 } }));
    });
    expect(checkWiring(car, defaultCatalog)).toEqual(checkWiring(car, defaultCatalog));
  });

  it('blocks Run when there is an error', () => {
    const car = carWith((_, part) => {
      part('steering').pins = { ...part('steering').pins, SIGNAL: { gpio: 6 } };
    });
    expect(canRun(checkWiring(car, defaultCatalog))).toBe(false);
  });
});
