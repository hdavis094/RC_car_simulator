// Test support: drives the default car round a track with pure pursuit and
// records the PWM it sent, so a test can replay it as a plain timeline.
import type { ActuatorSource, ScriptedPwm, TickOutput } from '../api/actuator-source.ts';
import { rotate, yawOf } from '../world/quat.ts';
import { leftOf, sampleCentreline } from '../world/track-geometry.ts';
import { trackLibrary } from '../world/track-library.ts';
import type { MeasuredRun } from './run.ts';
import {
  ARMED_BY_US,
  ESC_GPIO,
  STEERING_GPIO,
  steeringPulse,
  testRun,
  throttlePulse,
} from './test-support.ts';

const WHEELBASE_M = 0.335;
const LOOKAHEAD_M = 0.9;
const NO_BYTES = new Uint8Array(0);

export interface RecordedLap {
  readonly timeline: ScriptedPwm[];
  /** Sim seconds to run a replay for: the lap, with a little margin. */
  readonly seconds: number;
}

/** Drives one lap at `duty` and returns the PWM timeline that did it. */
export async function recordLap(trackId: string, duty = 0.25): Promise<RecordedLap> {
  const track = trackLibrary.load(trackId);
  const centre = sampleCentreline(track).points;
  const timeline: ScriptedPwm[] = [];
  const last = new Map<number, number>();
  const emit = (tUs: number, gpio: number, pulseUs: number): void => {
    if (last.get(gpio) === pulseUs) return;
    last.set(gpio, pulseUs);
    timeline.push({ tUs, gpio, pulseUs });
  };
  const driven: { run?: MeasuredRun } = {};

  const source: ActuatorSource = {
    async start() {},
    async stop() {},
    async step(input): Promise<TickOutput> {
      if (input.t0Us % 20_000 === 0) {
        emit(input.t0Us, ESC_GPIO, input.t0Us < ARMED_BY_US ? 1500 : throttlePulse(duty));
        if (input.t0Us < ARMED_BY_US) {
          emit(input.t0Us, STEERING_GPIO, 1500);
        } else {
          const { pose } = (driven.run as MeasuredRun).snapshot().car;
          const yaw = yawOf(pose.rotation);
          const heading = { x: -Math.sin(yaw), z: -Math.cos(yaw) };
          const back = rotate(pose.rotation, [0, 0, WHEELBASE_M / 2]);
          const rear = { x: pose.position[0] + back[0], z: pose.position[2] + back[2] };
          let nearest = 0;
          let best = Infinity;
          centre.forEach((p, i) => {
            const d = Math.hypot(p.x - rear.x, p.z - rear.z);
            if (d < best) {
              best = d;
              nearest = i;
            }
          });
          let j = nearest;
          while (Math.hypot(centre[j]!.x - rear.x, centre[j]!.z - rear.z) < LOOKAHEAD_M) {
            j = (j + 1) % centre.length;
          }
          const dx = centre[j]!.x - rear.x;
          const dz = centre[j]!.z - rear.z;
          const left = leftOf(heading);
          const sinAlpha = (dx * left.x + dz * left.z) / Math.hypot(dx, dz);
          const steer = Math.atan2(2 * WHEELBASE_M * sinAlpha, LOOKAHEAD_M);
          emit(input.t0Us, STEERING_GPIO, steeringPulse(steer));
        }
      }
      const pwm = timeline
        .filter((e) => e.tUs === input.t0Us)
        .map((e) => ({ gpio: e.gpio, periodUs: 20_000, pulseUs: e.pulseUs }));
      return { pwm, gpioWrites: [], serialTx: NO_BYTES, netEvents: [], logs: [] };
    },
  };

  const run = await testRun({ trackId, source });
  driven.run = run;
  const limitUs = 90_000_000;
  while (run.metrics().laps < 1 && run.clock.nowUs < limitUs) await run.step(100);
  const finishedUs = run.clock.nowUs;
  await run.stop();
  if (run.metrics().laps < 1)
    throw new Error(`the pure-pursuit driver did not finish a lap of ${trackId}`);
  return { timeline, seconds: finishedUs / 1_000_000 + 0.5 };
}
