import type { ActuatorSource, TickInput } from '../api/actuator-source.ts';

export interface SensorReadingLike {
  instanceId: string;
  [key: string]: unknown;
}

export interface TickInputLike {
  readings: SensorReadingLike[];
  gpioEdges: { gpio: number; tUs: number; level: boolean }[];
  t0Us: number;
  t1Us: number;
}

export function makeSource(): ActuatorSource & { inputs: TickInputLike[] } {
  const inputs: TickInputLike[] = [];
  const source: ActuatorSource & { inputs: TickInputLike[] } = {
    inputs,
    async start() {},
    async step(input: TickInput) {
      inputs.push(input as unknown as TickInputLike);
      return {
        pwm: [],
        gpioWrites: [],
        serialTx: new Uint8Array(0),
        netEvents: [],
        logs: [],
      };
    },
    async stop() {},
  };
  return source;
}
