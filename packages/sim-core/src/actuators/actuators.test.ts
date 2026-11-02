import { defaultCatalog, exampleCar } from '@rcsim/schema';
import { describe, expect, it } from 'vitest';
import type { ActuatorModel, ActuatorOutput } from '../api/actuators.ts';
import { createRngStreams } from '../clock/index.ts';
import { partContexts } from '../api/stubs/fake-run.ts';
import { createActuatorModel, throttleCurve } from './index.ts';

const contexts = partContexts({ car: exampleCar, catalog: defaultCatalog }, createRngStreams(1));
const part = (id: string) => {
  const found = contexts.find((c) => c.instance.instanceId === id);
  if (!found) throw new Error(`no part ${id}`);
  return found;
};

const PWM = (pulseUs: number) => ({ periodUs: 20_000, pulseUs });
const MAX_STEER = (28 * Math.PI) / 180;
const US = 1000;

const steering = (out: ActuatorOutput): number => {
  if (out.kind !== 'steering') throw new Error('not a steering output');
  return out.steerAngleRad;
};
const duty = (out: ActuatorOutput): number => {
  if (out.kind !== 'drive') throw new Error('not a drive output');
  return out.motorDuty;
};

/** Feeds a pulse and lets the model run for `ms`, 1 ms at a time. */
function settle(
  model: ActuatorModel,
  fromUs: number,
  ms: number,
): { out: ActuatorOutput; nowUs: number } {
  let nowUs = fromUs;
  let out = model.update(nowUs);
  for (let i = 0; i < ms; i++) {
    nowUs += US;
    out = model.update(nowUs);
  }
  return { out, nowUs };
}

describe('servo', () => {
  const make = () => createActuatorModel(part('steering'));

  it('is bound to its signal GPIO and steers straight with no signal', () => {
    const servo = make();
    expect(servo.gpio).toBe(25);
    expect(servo.template).toBe('servo');
    expect(steering(servo.update(5 * US))).toBe(-0);
  });

  it('maps pulses above neutral to right and below to left, through the linkage ratio', () => {
    const servo = make();
    servo.setPwm(PWM(2000), 0);
    const right = steering(settle(servo, 0, 1000).out);
    // 500 µs of a 2000 µs / 159° range = 39.75° of servo, × 0.7 linkage = 27.8° at the wheels
    expect(right).toBeCloseTo((-39.75 * 0.7 * Math.PI) / 180, 6);
    servo.setPwm(PWM(1000), 1_000_000);
    const left = steering(settle(servo, 1_000_000, 1000).out);
    expect(left).toBeCloseTo((39.75 * 0.7 * Math.PI) / 180, 6);
  });

  it('clamps to the chassis steering limit', () => {
    const servo = make();
    servo.setPwm(PWM(500), 0);
    expect(steering(settle(servo, 0, 2000).out)).toBeCloseTo(MAX_STEER, 6);
    servo.setPwm(PWM(2500), 2_000_000);
    expect(steering(settle(servo, 2_000_000, 2000).out)).toBeCloseTo(-MAX_STEER, 6);
  });

  it('moves no faster than its slew rate (400 °/s)', () => {
    const servo = make();
    servo.setPwm(PWM(2000), 0);
    const { out } = settle(servo, 0, 50); // 50 ms → at most 20° of servo travel
    expect(Math.abs(steering(out))).toBeCloseTo((20 * 0.7 * Math.PI) / 180, 4);
    // and it gets there: 39.75° takes about 99 ms
    expect(Math.abs(steering(settle(servo, 50_000, 60).out))).toBeCloseTo(
      (39.75 * 0.7 * Math.PI) / 180,
      6,
    );
  });

  it('ignores a pulse change within its deadband and holds its position without a signal', () => {
    const servo = make();
    servo.setPwm(PWM(1700), 0);
    const held = steering(settle(servo, 0, 1000).out);
    servo.setPwm(PWM(1700.5), 1_000_000); // inside the 1 µs deadband
    expect(steering(settle(servo, 1_000_000, 100).out)).toBe(held);
    servo.setPwm({ periodUs: 0, pulseUs: 0 }, 1_100_000); // the pin went quiet
    expect(steering(settle(servo, 1_100_000, 1000).out)).toBe(held);
  });
});

describe('ESC', () => {
  const make = () => createActuatorModel(part('esc'));
  const ARMING_MS = 3000;

  it('is bound to its signal GPIO and gives no output before it has a signal', () => {
    const esc = make();
    expect(esc.gpio).toBe(26);
    expect(duty(esc.update(10_000_000))).toBe(0);
  });

  it('gives no output until neutral has been held for the arming time', () => {
    const esc = make();
    esc.setPwm(PWM(1500), 0);
    const out = (nowUs: number) => duty(esc.update(nowUs));
    expect(out(1000)).toBe(0);
    // a throttle pulse while still disarmed is ignored
    esc.setPwm(PWM(1800), 1_000_000);
    expect(out(1_001_000)).toBe(0);
    // neutral again at 2 s: the wait starts over, so 4.9 s is still too early…
    esc.setPwm(PWM(1500), 2_000_000);
    esc.setPwm(PWM(1800), 4_900_000);
    expect(out(4_901_000)).toBe(0);
    // …but a clean 3 s of neutral arms it
    esc.setPwm(PWM(1500), 5_000_000);
    expect(out(5_000_000 + (ARMING_MS - 1) * US)).toBe(0);
    esc.setPwm(PWM(1800), 5_000_000 + ARMING_MS * US);
    expect(out(5_000_000 + ARMING_MS * US + US)).toBeGreaterThan(0);
  });

  it('stays armed once armed, and disarms if the signal is lost', () => {
    const esc = make();
    esc.setPwm(PWM(1500), 0);
    esc.setPwm(PWM(1700), ARMING_MS * US + US);
    expect(duty(esc.update(ARMING_MS * US + 2 * US))).toBeGreaterThan(0);
    esc.setPwm({ periodUs: 0, pulseUs: 0 }, 5_000_000);
    expect(duty(esc.update(5_001_000))).toBe(0);
    esc.setPwm(PWM(1700), 5_002_000); // signal back, but it must be re-armed
    expect(duty(esc.update(5_003_000))).toBe(0);
  });

  describe('once armed', () => {
    const armed = (): ActuatorModel => {
      const esc = make();
      esc.setPwm(PWM(1500), 0);
      esc.update(ARMING_MS * US + 1000);
      return esc;
    };
    const at = (esc: ActuatorModel, pulseUs: number): number => {
      esc.setPwm(PWM(pulseUs), 4_000_000);
      return duty(esc.update(4_001_000));
    };

    it('has a deadband around neutral', () => {
      const esc = armed();
      for (const pulse of [1500, 1470, 1530, 1460, 1540]) expect(at(esc, pulse)).toBe(0);
      expect(at(esc, 1541)).toBeGreaterThan(0);
      expect(at(esc, 1459)).toBeLessThan(0);
    });

    it('scales continuously from the edge of the deadband to full', () => {
      const esc = armed();
      expect(at(esc, 1541)).toBeLessThan(0.01);
      expect(at(esc, 1770)).toBeCloseTo(0.5, 6); // halfway between 1540 and 2000
      expect(at(esc, 2000)).toBe(1);
      expect(at(esc, 2400)).toBe(1);
      expect(at(esc, 1230)).toBeCloseTo(-0.5, 6);
      expect(at(esc, 1000)).toBe(-1);
    });
  });

  it('has no reverse when the part does not allow it', () => {
    const base = part('esc');
    const definition = base.definition;
    if (!('behavior' in definition) || definition.behavior.template !== 'esc-motor')
      throw new Error('not an ESC');
    const noReverse = {
      ...base,
      definition: {
        ...definition,
        behavior: {
          ...definition.behavior,
          params: { ...definition.behavior.params, reverse: false },
        },
      },
    };
    const esc = createActuatorModel(noReverse);
    esc.setPwm(PWM(1500), 0);
    esc.update(ARMING_MS * US + 1000);
    esc.setPwm(PWM(1200), 4_000_000);
    expect(duty(esc.update(4_001_000))).toBe(0);
    esc.setPwm(PWM(1800), 4_002_000);
    expect(duty(esc.update(4_003_000))).toBeGreaterThan(0);
  });
});

describe('throttle curve', () => {
  const curve = [
    { input: 0, output: 0 },
    { input: 0.5, output: 0.2 },
    { input: 1, output: 1 },
  ];
  it('interpolates between its points', () => {
    expect(throttleCurve(curve, 0)).toBe(0);
    expect(throttleCurve(curve, 0.25)).toBeCloseTo(0.1);
    expect(throttleCurve(curve, 0.5)).toBeCloseTo(0.2);
    expect(throttleCurve(curve, 0.75)).toBeCloseTo(0.6);
    expect(throttleCurve(curve, 1)).toBe(1);
  });
  it('clamps its input', () => {
    expect(throttleCurve(curve, -1)).toBe(0);
    expect(throttleCurve(curve, 2)).toBe(1);
  });
});

describe('createActuatorModel', () => {
  it('refuses parts that are not actuators', () => {
    expect(() => createActuatorModel(part('battery'))).toThrow(/not an actuator|GPIO/);
  });
});
