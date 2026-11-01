// The messages behind vectors/. Changing one changes the golden bytes; hal's
// C++ tests replay the same files, so treat edits as protocol changes.
import { LIMITS, PROTOCOL_VERSION, type Message } from '../src/protocol.ts';

const MAX_SAFE = Number.MAX_SAFE_INTEGER;

export const VALID_VECTORS: Record<string, Message> = {
  hello: { type: 'HELLO', protocolVersion: PROTOCOL_VERSION, halVersion: '0.1.0' },
  'hello-bom': { type: 'HELLO', protocolVersion: PROTOCOL_VERSION, halVersion: '\uFEFFhal 0.1' },
  'step-zero-power-on-readings': {
    type: 'STEP',
    tick: 0,
    t0Us: 0,
    t1Us: 1000,
    readings: [{ device: 5, tUs: 0, type: 'analog', volts: 2.0625 }],
    gpioEdges: [],
    serialRx: new Uint8Array(0),
  },
  'hello-empty-version': { type: 'HELLO', protocolVersion: PROTOCOL_VERSION, halVersion: '' },
  'hello-max-string': {
    type: 'HELLO',
    protocolVersion: PROTOCOL_VERSION,
    halVersion: 'v'.repeat(LIMITS.stringBytes),
  },
  config: {
    type: 'CONFIG',
    protocolVersion: PROTOCOL_VERSION,
    tickUs: 1000,
    seed: 1,
    halCallCostNs: 1000,
    loopCostNs: 5000,
    net: { bindAddress: '127.0.0.1' },
    devices: [
      {
        instanceId: 'esc',
        kind: 'esc',
        pins: [{ name: 'SIGNAL', gpio: 26 }],
        defaultI2cAddress: 0,
        targetI2cAddress: 0,
      },
      {
        instanceId: 'steering',
        kind: 'servo',
        pins: [{ name: 'SIGNAL', gpio: 25 }],
        defaultI2cAddress: 0,
        targetI2cAddress: 0,
      },
      {
        instanceId: 'tof_left',
        kind: 'vl53l0x',
        pins: [
          { name: 'SDA', gpio: 21 },
          { name: 'SCL', gpio: 22 },
          { name: 'XSHUT', gpio: 16 },
        ],
        defaultI2cAddress: 0x29,
        targetI2cAddress: 0x30,
      },
      {
        instanceId: 'imu',
        kind: 'mpu6050',
        pins: [
          { name: 'SDA', gpio: 21 },
          { name: 'SCL', gpio: 22 },
        ],
        defaultI2cAddress: 0x68,
        targetI2cAddress: 0x68,
      },
      {
        instanceId: 'sonar',
        kind: 'hc-sr04',
        pins: [
          { name: 'TRIG', gpio: 13 },
          { name: 'ECHO', gpio: 34 },
        ],
        defaultI2cAddress: 0,
        targetI2cAddress: 0,
      },
      {
        instanceId: 'battery_sense',
        kind: 'analog',
        pins: [{ name: 'OUT', gpio: 35 }],
        defaultI2cAddress: 0,
        targetI2cAddress: 0,
      },
    ],
  },
  'config-no-devices': {
    type: 'CONFIG',
    protocolVersion: PROTOCOL_VERSION,
    tickUs: 1000,
    seed: 0xffff_ffff,
    halCallCostNs: 0,
    loopCostNs: 0,
    net: { bindAddress: '0.0.0.0' },
    devices: [],
  },
  'step-empty': {
    type: 'STEP',
    tick: 0,
    t0Us: 0,
    t1Us: 1000,
    readings: [],
    gpioEdges: [],
    serialRx: new Uint8Array(0),
  },
  'step-full': {
    type: 'STEP',
    tick: 1234,
    t0Us: 1_234_000,
    t1Us: 1_235_000,
    readings: [
      { device: 2, tUs: 1_233_100, type: 'distance', mm: 812, status: 'valid' },
      { device: 2, tUs: 1_233_900, type: 'distance', mm: 8190, status: 'no-target' },
      {
        device: 3,
        tUs: 1_233_000,
        type: 'imu',
        accel: [0.5, -0.25, 9.8125],
        gyro: [0, 0.125, -1.5],
        tempC: 24.5,
      },
      { device: 5, tUs: 1_233_500, type: 'analog', volts: 2.0625 },
    ],
    gpioEdges: [
      { gpio: 34, tUs: 1_234_200, level: true },
      { gpio: 34, tUs: 1_234_780, level: false },
    ],
    serialRx: new TextEncoder().encode('mode auto\n'),
    netFaults: { latencyUs: 20_000, lossPpm: 50_000, dropout: false },
  },
  'step-max-time': {
    type: 'STEP',
    tick: MAX_SAFE,
    t0Us: MAX_SAFE - 1000,
    t1Us: MAX_SAFE,
    readings: [],
    gpioEdges: [],
    serialRx: new Uint8Array(0),
    netFaults: { latencyUs: 0xffff_ffff, lossPpm: 1_000_000, dropout: true },
  },
  'step-max-serial': {
    type: 'STEP',
    tick: 7,
    t0Us: 7000,
    t1Us: 8000,
    readings: [],
    gpioEdges: [],
    serialRx: Uint8Array.from({ length: LIMITS.serialBytes }, (_, i) => i % 256),
  },
  'step-done-empty': {
    type: 'STEP_DONE',
    tick: 0,
    pwm: [],
    gpioWrites: [],
    serialTx: new Uint8Array(0),
    netEvents: [],
    logs: [],
  },
  'step-done-full': {
    type: 'STEP_DONE',
    tick: 1234,
    pwm: [
      { gpio: 25, periodUs: 20_000, pulseUs: 1500 },
      { gpio: 26, periodUs: 0, pulseUs: 0 },
    ],
    gpioWrites: [
      { gpio: 16, tUs: 1_234_010, level: true },
      { gpio: 13, tUs: 1_234_020, level: true },
      { gpio: 13, tUs: 1_234_030, level: false },
    ],
    serialTx: new TextEncoder().encode('tof 812 1200 640\n'),
    netEvents: [
      {
        type: 'listen',
        proto: 'tcp',
        firmwarePort: 3333,
        hostPort: 41333,
        bindAddress: '127.0.0.1',
      },
      { type: 'connect', firmwarePort: 3333, peer: '127.0.0.1:53122' },
      { type: 'disconnect', firmwarePort: 3333, peer: '127.0.0.1:53122' },
      { type: 'unlisten', proto: 'udp', firmwarePort: 4210 },
    ],
    logs: [
      { level: 'info', text: 'Wire.begin(21, 22)' },
      { level: 'warn', text: 'VL53L0X at 0x29 not answering: XSHUT low — retrying' },
    ],
  },
  'step-done-max-logs': {
    type: 'STEP_DONE',
    tick: 9,
    pwm: [],
    gpioWrites: [],
    serialTx: new Uint8Array(0),
    netEvents: [],
    logs: Array.from({ length: LIMITS.logLines }, (_, i) => ({
      level: (['debug', 'info', 'warn', 'error'] as const)[i % 4] ?? 'debug',
      text: `line ${i}`,
    })),
  },
  'bye-normal': { type: 'BYE', reason: 'normal', message: '' },
  'bye-version-mismatch': {
    type: 'BYE',
    reason: 'version-mismatch',
    message: 'sim speaks protocol 1, firmware sent 2',
  },
  'bye-stalled': { type: 'BYE', reason: 'stalled', message: 'no STEP_DONE for 2000 ms' },
};

const le32 = (n: number): number[] => [
  n & 0xff,
  (n >>> 8) & 0xff,
  (n >>> 16) & 0xff,
  (n >>> 24) & 0xff,
];
/** A frame from a raw body: [u32 length][body]. */
const frame = (body: number[]): Uint8Array => Uint8Array.from([...le32(body.length), ...body]);
const helloBody = (extra: number[] = []): number[] => [0x01, 0x01, 0x00, 0x00, 0x00, ...extra];
const stepHeader = [0x03, ...new Array<number>(24).fill(0)]; // tick, t0, t1 = 0

/** Frames a decoder must reject, with what is wrong with each. */
export const MALFORMED_VECTORS: Record<string, { bytes: Uint8Array; description: string }> = {
  'unknown-type': { bytes: frame([0x09]), description: 'message type 0x09 does not exist' },
  'zero-length': { bytes: Uint8Array.from(le32(0)), description: 'length 0: no type byte' },
  'oversize-length': {
    bytes: Uint8Array.from(le32(LIMITS.frameBytes + 1)),
    description: 'length above 1 MiB',
  },
  'truncated-hello': {
    bytes: frame([0x01, 0x01, 0x00, 0x05, 0x00, 0x61]),
    description: 'string says 5 bytes, 1 follows',
  },
  'trailing-bytes': {
    bytes: frame(helloBody([0xff])),
    description: 'a byte after the HELLO payload',
  },
  'bad-utf8': {
    bytes: frame([0x01, 0x01, 0x00, 0x02, 0x00, 0xc3, 0x28]),
    description: 'halVersion is not valid UTF-8',
  },
  'string-over-limit': {
    bytes: frame([0x01, 0x01, 0x00, 0x01, 0x04]),
    description: 'string length 1025 is over the 1024 limit',
  },
  'bad-bool': {
    // STEP with no readings, one edge whose level byte is 2.
    bytes: frame([
      ...stepHeader,
      0x00,
      0x00,
      0x01,
      0x00,
      34,
      ...new Array<number>(8).fill(0),
      0x02,
    ]),
    description: 'GpioEdge.level is 2',
  },
  'bad-enum': {
    // STEP with one reading of type 9.
    bytes: frame([...stepHeader, 0x01, 0x00, 0x00, 0x00, ...new Array<number>(8).fill(0), 0x09]),
    description: 'reading type 9 does not exist',
  },
  'array-over-limit': {
    bytes: frame([...stepHeader, ...[4097 & 0xff, 4097 >> 8]]),
    description: 'readings count 4097 is over the 4096 limit',
  },
  'serial-over-limit': {
    bytes: frame([...stepHeader, 0x00, 0x00, 0x00, 0x00, ...le32(LIMITS.serialBytes + 1)]),
    description: 'serialRx length 16385 is over the 16384 limit',
  },
  'bad-optional': {
    bytes: frame([...stepHeader, 0x00, 0x00, 0x00, 0x00, ...le32(0), 0x02]),
    description: 'netFaults flag is 2',
  },
  'u64-over-safe': {
    bytes: frame([
      0x03,
      0,
      0,
      0,
      0,
      0,
      0,
      0x20,
      0,
      ...new Array<number>(16).fill(0),
      0,
      0,
      0,
      0,
      ...le32(0),
      0,
    ]),
    description: 'tick 2^53 is above 2^53 - 1',
  },
  'f32-infinity': {
    // STEP with one analog reading whose volts are +Infinity (0x7F800000).
    bytes: frame([
      ...stepHeader,
      0x01,
      0x00,
      0x00,
      0x00,
      ...new Array<number>(8).fill(0),
      0x03,
      0x00,
      0x00,
      0x80,
      0x7f,
    ]),
    description: 'an f32 is +Infinity',
  },
  'f32-nan': {
    bytes: frame([
      ...stepHeader,
      0x01,
      0x00,
      0x00,
      0x00,
      ...new Array<number>(8).fill(0),
      0x03,
      0x00,
      0x00,
      0xc0,
      0x7f,
    ]),
    description: 'an f32 is NaN',
  },
  'loss-over-million': {
    bytes: frame([
      ...stepHeader,
      0x00,
      0x00,
      0x00,
      0x00,
      ...le32(0),
      0x01,
      ...le32(0),
      ...le32(1_000_001),
      0x00,
    ]),
    description: 'netFaults.lossPpm is above 1000000',
  },
};
