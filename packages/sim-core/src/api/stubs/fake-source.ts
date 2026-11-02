import type { PwmOutput } from '@rcsim/sim-protocol';
import type {
  ActuatorSource,
  ActuatorSourceSetup,
  ScriptedPwm,
  TickInput,
  TickOutput,
} from '../actuator-source.ts';
import { ActuatorSourceEnded } from '../actuator-source.ts';

/**
 * Plays a PWM timeline: each entry takes effect in the tick containing its
 * `tUs`. Records every input it was given, so tests can check what a Run
 * would have sent the firmware. Ends with `finished` after `endUs`, if set.
 */
export class FakeActuatorSource implements ActuatorSource {
  readonly inputs: TickInput[] = [];
  setup: ActuatorSourceSetup | undefined;
  readonly #timeline: ScriptedPwm[];
  readonly #endUs: number | undefined;
  #stopped = false;

  constructor(timeline: readonly ScriptedPwm[] = [], options: { endUs?: number } = {}) {
    this.#timeline = [...timeline].sort((a, b) => a.tUs - b.tUs);
    this.#endUs = options.endUs;
  }

  async start(setup: ActuatorSourceSetup): Promise<void> {
    this.setup = setup;
  }

  async step(input: TickInput): Promise<TickOutput> {
    if (this.#stopped) throw new ActuatorSourceEnded({ kind: 'error', message: 'stopped' });
    if (this.#endUs !== undefined && input.t0Us >= this.#endUs) {
      throw new ActuatorSourceEnded({ kind: 'finished' });
    }
    this.inputs.push(input);
    const pwm: PwmOutput[] = this.#timeline
      .filter((entry) => entry.tUs >= input.t0Us && entry.tUs < input.t1Us)
      .map((entry) => ({
        gpio: entry.gpio,
        periodUs: entry.periodUs ?? 20_000,
        pulseUs: entry.pulseUs,
      }));
    return { pwm, gpioWrites: [], serialTx: new Uint8Array(0), netEvents: [], logs: [] };
  }

  async stop(): Promise<void> {
    this.#stopped = true;
  }
}
