import { z } from 'zod';

// Control protocol v1. SPEC.md is normative. Objects are not strict:
// unknown fields are stripped, so newer peers can add fields.

export const PROTOCOL_VERSION = 1;
export const DEFAULT_PORT = 3333;
export const FAILSAFE_MS = 500;
export const TELEMETRY_INTERVAL_MS = 50;
export const MAX_LINE_BYTES = 4096;

export const Mode = z.enum(['manual', 'auto']);
export type Mode = z.infer<typeof Mode>;

const unit = z.number().transform((v) => Math.min(1, Math.max(-1, v)));

export const Hello = z.object({
  t: z.literal('hello'),
  name: z.string(),
  fw: z.string(),
  proto: z.int(),
});
export type Hello = z.infer<typeof Hello>;

export const Telemetry = z.object({
  t: z.literal('telemetry'),
  ms: z.int().min(0),
  mode: Mode,
  estop: z.boolean(),
  throttle: unit,
  steer: unit,
  tof_mm: z.array(z.int().min(0)).optional(),
  batt_mv: z.int().min(0).optional(),
  yaw_dps: z.number().optional(),
});
export type Telemetry = z.infer<typeof Telemetry>;

export const Log = z.object({ t: z.literal('log'), msg: z.string() });
export type Log = z.infer<typeof Log>;

export const Drive = z.object({
  t: z.literal('drive'),
  seq: z.int().min(0).max(0xffff_ffff),
  throttle: unit,
  steer: unit,
});
export type Drive = z.infer<typeof Drive>;

export const SetMode = z.object({ t: z.literal('mode'), mode: Mode });
export type SetMode = z.infer<typeof SetMode>;

export const Estop = z.object({ t: z.literal('estop') });
export type Estop = z.infer<typeof Estop>;

/** Messages the car sends. */
export const CarMessage = z.discriminatedUnion('t', [Hello, Telemetry, Log]);
export type CarMessage = z.infer<typeof CarMessage>;

/** Messages a client sends. */
export const ClientMessage = z.discriminatedUnion('t', [Drive, SetMode, Estop]);
export type ClientMessage = z.infer<typeof ClientMessage>;

export type ParseResult<T> =
  | { readonly ok: true; readonly message: T }
  | { readonly ok: false; readonly line: string; readonly reason: string };

function parseWith<T>(schema: z.ZodType<T>, line: string): ParseResult<T> {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return { ok: false, line, reason: 'not JSON' };
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, line, reason: 'not a JSON object' };
  }
  const result = schema.safeParse(value);
  if (!result.success) {
    const t = (value as { t?: unknown }).t;
    return {
      ok: false,
      line,
      reason: typeof t === 'string' ? `invalid or unknown message "${t}"` : 'missing "t"',
    };
  }
  return { ok: true, message: result.data };
}

/** Parses one line from the car. */
export const parseCarLine = (line: string): ParseResult<CarMessage> => parseWith(CarMessage, line);

/** Parses one line from a client. */
export const parseClientLine = (line: string): ParseResult<ClientMessage> =>
  parseWith(ClientMessage, line);

/** Serialises a message as one protocol line, `\n` included. */
export function encodeLine(message: CarMessage | ClientMessage): string {
  return `${JSON.stringify(message)}\n`;
}

/** Whether `seq` is newer than `last` under 32-bit wraparound (SPEC.md → drive). */
export function isNewerSeq(seq: number, last: number | undefined): boolean {
  if (last === undefined) return true;
  const delta = (seq - last + 0x1_0000_0000) % 0x1_0000_0000;
  return delta >= 1 && delta <= 0x8000_0000;
}
