import type {
  ActuatorSource,
  ActuatorSourceSetup,
  CreateScriptedSource,
  ScriptedPwm,
  TickInput,
  TickOutput,
} from '../api/actuator-source.ts';
import { ActuatorSourceEnded } from '../api/actuator-source.ts';

const NO_BYTES = new Uint8Array(0);

/**
 * Plays a PWM timeline: each entry takes effect in the tick that contains its
 * `tUs` (entries from before the first tick apply in it). A timeline entry
 * sets a channel and it stays until a later entry changes it, like firmware
 * that writes the servo only when the value changes.
 */
export const createScriptedSource: CreateScriptedSource = (timeline) =>
  new ScriptedSource(timeline);

class ScriptedSource implements ActuatorSource {
  readonly #timeline: readonly ScriptedPwm[];
  #next = 0;
  #stopped = false;

  constructor(timeline: readonly ScriptedPwm[]) {
    for (const entry of timeline) {
      if (!Number.isFinite(entry.tUs) || entry.tUs < 0 || !Number.isInteger(entry.gpio)) {
        throw new Error(`bad timeline entry ${JSON.stringify(entry)}`);
      }
    }
    // A stable sort keeps same-time entries in file order.
    this.#timeline = [...timeline].sort((a, b) => a.tUs - b.tUs);
  }

  async start(_setup: ActuatorSourceSetup): Promise<void> {
    this.#next = 0;
  }

  async step(input: TickInput): Promise<TickOutput> {
    if (this.#stopped) throw new ActuatorSourceEnded({ kind: 'error', message: 'stopped' });
    const pwm = [];
    while (this.#next < this.#timeline.length) {
      const entry = this.#timeline[this.#next] as ScriptedPwm;
      if (entry.tUs >= input.t1Us) break;
      pwm.push({ gpio: entry.gpio, periodUs: entry.periodUs ?? 20_000, pulseUs: entry.pulseUs });
      this.#next += 1;
    }
    return { pwm, gpioWrites: [], serialTx: NO_BYTES, netEvents: [], logs: [] };
  }

  async stop(): Promise<void> {
    this.#stopped = true;
  }
}
