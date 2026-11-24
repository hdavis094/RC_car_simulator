import { defaultCatalog, exampleCar, type EscMotorParams } from '@rcsim/schema';
import { describe, expect, it } from 'vitest';
import type { ActuatorModel, ActuatorOutput } from '../api/actuators.ts';
import { createRngStreams } from '../clock/index.ts';
import { partContexts } from '../api/stubs/fake-run.ts';
import { createStageTwoActuatorModel } from './index.ts';

const contexts = partContexts({ car: exampleCar, catalog: defaultCatalog }, createRngStreams(1));
const escPart = contexts.find((c) => c.instance.instanceId === 'esc')!;

const FRAME_US = 20_000;
const ARMING_US = 3_000_000;
const FORWARD = 1770; // halfway between the deadband edge and full forward
const NEUTRAL = 1500;
const BACK = 1230; // halfway between the deadband edge and full back

function withParams(params: Partial<EscMotorParams>): typeof escPart {
  const definition = escPart.definition;
  if (!('behavior' in definition) || definition.behavior.template !== 'esc-motor')
    throw new Error('not an ESC');
  return {
    ...escPart,
    definition: {
      ...definition,
      behavior: { ...definition.behavior, params: { ...definition.behavior.params, ...params } },
    },
  };
}

/** An ESC on its own clock: `send` writes a pulse and lets it run for a while. */
function bench(part = escPart) {
  const esc: ActuatorModel = createStageTwoActuatorModel(part);
  let nowUs = 0;
  const send = (
    pulseUs: number,
    forUs = FRAME_US,
    periodUs = FRAME_US,
  ): Extract<ActuatorOutput, { kind: 'drive' }> => {
    esc.setPwm({ periodUs, pulseUs }, nowUs);
    nowUs += forUs;
    const out = esc.update(nowUs);
    if (out.kind !== 'drive') throw new Error('not a drive output');
    return out;
  };
  return {
    send,
    arm: () => send(NEUTRAL, ARMING_US),
  };
}

const COAST = { kind: 'drive', motorDuty: 0 };
const forward = { kind: 'drive', motorDuty: expect.closeTo(0.5, 6) as number };
const braking = { kind: 'drive', motorDuty: expect.closeTo(-0.5, 6) as number, brake: true };
const reversing = { kind: 'drive', motorDuty: expect.closeTo(-0.5, 6) as number };

describe('stage-2 ESC: brake, neutral, reverse', () => {
  it('brakes on the first push backwards, from a forward drive', () => {
    const esc = bench();
    esc.arm();
    expect(esc.send(FORWARD)).toEqual(forward);
    expect(esc.send(BACK)).toEqual(braking);
    // held back, it never turns into reverse by itself
    expect(esc.send(BACK, 10_000_000)).toEqual(braking);
  });

  it('brakes first even straight after arming', () => {
    const esc = bench();
    esc.arm();
    expect(esc.send(BACK)).toEqual(braking);
  });

  it('reverses on the second push, after a return to neutral', () => {
    const esc = bench();
    esc.arm();
    esc.send(FORWARD);
    esc.send(BACK);
    expect(esc.send(NEUTRAL)).toEqual(COAST);
    expect(esc.send(BACK)).toEqual(reversing);
    expect(esc.send(BACK, 5_000_000)).toEqual(reversing);
  });

  it('needs neutral for at least one PWM frame before the second push counts', () => {
    const esc = bench();
    esc.arm();
    esc.send(BACK);
    esc.send(NEUTRAL, FRAME_US - 1);
    expect(esc.send(BACK)).toEqual(braking);
    esc.send(NEUTRAL, FRAME_US);
    expect(esc.send(BACK)).toEqual(reversing);
  });

  it('goes back to reverse after neutral without another brake tap', () => {
    const esc = bench();
    esc.arm();
    esc.send(BACK);
    esc.send(NEUTRAL);
    esc.send(BACK);
    esc.send(NEUTRAL);
    expect(esc.send(BACK)).toEqual(reversing);
  });

  it('brakes again once forward throttle has been used', () => {
    const esc = bench();
    esc.arm();
    esc.send(BACK);
    esc.send(NEUTRAL);
    esc.send(BACK); // reversing
    expect(esc.send(FORWARD)).toEqual(forward);
    expect(esc.send(BACK)).toEqual(braking);
    // forward between the two taps cancels the first
    esc.send(NEUTRAL);
    esc.send(FORWARD);
    esc.send(NEUTRAL);
    expect(esc.send(BACK)).toEqual(braking);
  });

  it('only ever brakes when the part has reverse disabled', () => {
    const esc = bench(withParams({ reverse: false }));
    esc.arm();
    for (let tap = 0; tap < 3; tap++) {
      expect(esc.send(BACK)).toEqual(braking);
      expect(esc.send(NEUTRAL)).toEqual(COAST);
    }
    expect(esc.send(FORWARD)).toEqual(forward);
  });

  it('ignores taps made before it is armed', () => {
    const esc = bench();
    esc.send(NEUTRAL, 1_000_000);
    expect(esc.send(BACK)).toEqual(COAST);
    expect(esc.send(NEUTRAL)).toEqual(COAST);
    expect(esc.send(BACK)).toEqual(COAST);
    esc.arm();
    expect(esc.send(BACK)).toEqual(braking);
  });

  it('forgets the first tap when the signal is lost, and must re-arm', () => {
    const esc = bench();
    esc.arm();
    esc.send(BACK);
    esc.send(NEUTRAL);
    expect(esc.send(0, FRAME_US, 0)).toEqual(COAST);
    expect(esc.send(BACK)).toEqual(COAST);
    esc.arm();
    expect(esc.send(BACK)).toEqual(braking);
  });
});

describe('stage-2 actuators', () => {
  it('keeps the same servo model', () => {
    const steering = contexts.find((c) => c.instance.instanceId === 'steering')!;
    const servo = createStageTwoActuatorModel(steering);
    servo.setPwm({ periodUs: FRAME_US, pulseUs: 2000 }, 0);
    const out = servo.update(1_000_000);
    expect(out.kind === 'steering' && out.steerAngleRad).toBeCloseTo(
      (-39.75 * 0.7 * Math.PI) / 180,
      6,
    );
  });
});
