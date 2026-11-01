// Message types and constants of sim-protocol v1. SPEC.md is normative.

export const PROTOCOL_VERSION = 1;

/** Limits from SPEC.md → Limits. Exceeding any of them is a malformed frame. */
export const LIMITS = {
  frameBytes: 1_048_576,
  stringBytes: 1024,
  arrayLength: 4096,
  serialBytes: 16_384,
  logLines: 256,
} as const;

export const MESSAGE_TYPE_CODES = {
  HELLO: 0x01,
  CONFIG: 0x02,
  STEP: 0x03,
  STEP_DONE: 0x04,
  BYE: 0x05,
} as const;
export type MessageType = keyof typeof MESSAGE_TYPE_CODES;

/** Enum values in the order of their wire codes (index = code, except where noted). */
export const READING_TYPES = ['distance', 'imu', 'analog'] as const; // codes 1, 2, 3
export const DISTANCE_STATUSES = ['valid', 'no-target', 'signal-fail'] as const; // 0, 1, 2
export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const; // 0..3
export const NET_PROTOS = ['tcp', 'udp'] as const; // 0, 1
export const NET_EVENT_TYPES = ['listen', 'unlisten', 'connect', 'disconnect'] as const; // 1..4
export const BYE_REASONS = [
  'normal',
  'version-mismatch',
  'malformed',
  'stalled',
  'shutdown',
  'firmware-exit',
] as const; // 0..5

export type ReadingType = (typeof READING_TYPES)[number];
export type DistanceStatus = (typeof DISTANCE_STATUSES)[number];
export type LogLevel = (typeof LOG_LEVELS)[number];
export type NetProto = (typeof NET_PROTOS)[number];
export type NetEventType = (typeof NET_EVENT_TYPES)[number];
export type ByeReason = (typeof BYE_REASONS)[number];

/** Device kinds hal models in v1 (SPEC.md → CONFIG). */
export const DEVICE_KINDS = ['vl53l0x', 'mpu6050', 'hc-sr04', 'servo', 'esc', 'analog'] as const;
export type DeviceKind = (typeof DEVICE_KINDS)[number];

export type Vec3 = readonly [number, number, number];

export interface Hello {
  readonly type: 'HELLO';
  readonly protocolVersion: number;
  readonly halVersion: string;
}

export interface DevicePin {
  readonly name: string;
  readonly gpio: number;
}

export interface Device {
  readonly instanceId: string;
  /** One of DEVICE_KINDS; kept as a string so a newer sim can name kinds an older hal ignores. */
  readonly kind: string;
  readonly pins: readonly DevicePin[];
  /** 0 when the device is not on I²C. */
  readonly defaultI2cAddress: number;
  /** 0 when the device is not on I²C. */
  readonly targetI2cAddress: number;
}

export interface Config {
  readonly type: 'CONFIG';
  readonly protocolVersion: number;
  readonly tickUs: number;
  readonly seed: number;
  readonly halCallCostNs: number;
  readonly loopCostNs: number;
  readonly net: { readonly bindAddress: string };
  readonly devices: readonly Device[];
}

interface ReadingBase {
  /** Index into CONFIG.devices. */
  readonly device: number;
  readonly tUs: number;
}

export type Reading =
  | (ReadingBase & {
      readonly type: 'distance';
      readonly mm: number;
      readonly status: DistanceStatus;
    })
  | (ReadingBase & {
      readonly type: 'imu';
      /** m/s², chip axes, gravity included. */
      readonly accel: Vec3;
      /** rad/s, chip axes. */
      readonly gyro: Vec3;
      readonly tempC: number;
    })
  | (ReadingBase & { readonly type: 'analog'; readonly volts: number });

export interface GpioEdge {
  readonly gpio: number;
  readonly tUs: number;
  readonly level: boolean;
}

export interface NetFaults {
  readonly latencyUs: number;
  readonly lossPpm: number;
  readonly dropout: boolean;
}

export interface Step {
  readonly type: 'STEP';
  readonly tick: number;
  readonly t0Us: number;
  readonly t1Us: number;
  readonly readings: readonly Reading[];
  readonly gpioEdges: readonly GpioEdge[];
  readonly serialRx: Uint8Array;
  /** Present only when the settings changed. */
  readonly netFaults?: NetFaults | undefined;
}

export interface PwmOutput {
  readonly gpio: number;
  /** 0 means the output stopped. */
  readonly periodUs: number;
  readonly pulseUs: number;
}

export interface GpioWrite {
  readonly gpio: number;
  readonly tUs: number;
  readonly level: boolean;
}

export type NetEvent =
  | {
      readonly type: 'listen';
      readonly proto: NetProto;
      readonly firmwarePort: number;
      readonly hostPort: number;
      readonly bindAddress: string;
    }
  | { readonly type: 'unlisten'; readonly proto: NetProto; readonly firmwarePort: number }
  | { readonly type: 'connect'; readonly firmwarePort: number; readonly peer: string }
  | { readonly type: 'disconnect'; readonly firmwarePort: number; readonly peer: string };

export interface LogLine {
  readonly level: LogLevel;
  readonly text: string;
}

export interface StepDone {
  readonly type: 'STEP_DONE';
  readonly tick: number;
  readonly pwm: readonly PwmOutput[];
  readonly gpioWrites: readonly GpioWrite[];
  readonly serialTx: Uint8Array;
  readonly netEvents: readonly NetEvent[];
  readonly logs: readonly LogLine[];
}

export interface Bye {
  readonly type: 'BYE';
  readonly reason: ByeReason;
  readonly message: string;
}

export type Message = Hello | Config | Step | StepDone | Bye;

/**
 * A violation of the protocol: a malformed frame or an unsupported version.
 * `reason` is the BYE reason to send before closing.
 */
export class ProtocolError extends Error {
  readonly reason: 'malformed' | 'version-mismatch';

  constructor(reason: 'malformed' | 'version-mismatch', message: string) {
    super(message);
    this.name = 'ProtocolError';
    this.reason = reason;
  }
}
