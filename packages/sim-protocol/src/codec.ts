import { ByteReader, ByteWriter } from './bytes.ts';
import {
  BYE_REASONS,
  DISTANCE_STATUSES,
  LIMITS,
  LOG_LEVELS,
  MESSAGE_TYPE_CODES,
  NET_EVENT_TYPES,
  NET_PROTOS,
  ProtocolError,
  READING_TYPES,
  type Device,
  type GpioEdge,
  type Message,
  type MessageType,
  type NetEvent,
  type Reading,
  type Vec3,
} from './protocol.ts';

const code = <T>(values: readonly T[], value: T, what: string, firstCode = 0): number => {
  const index = values.indexOf(value);
  if (index < 0) throw new ProtocolError('malformed', `unknown ${what} "${String(value)}"`);
  return index + firstCode;
};

const TYPE_BY_CODE = new Map<number, MessageType>(
  Object.entries(MESSAGE_TYPE_CODES).map(([name, c]) => [c, name as MessageType]),
);

function writeVec3(w: ByteWriter, v: Vec3): void {
  w.f32(v[0]);
  w.f32(v[1]);
  w.f32(v[2]);
}

function writeReading(w: ByteWriter, r: Reading): void {
  w.u16(r.device);
  w.u64(r.tUs);
  w.u8(code(READING_TYPES, r.type, 'reading type', 1));
  switch (r.type) {
    case 'distance':
      w.u16(r.mm);
      w.u8(code(DISTANCE_STATUSES, r.status, 'distance status'));
      break;
    case 'imu':
      writeVec3(w, r.accel);
      writeVec3(w, r.gyro);
      w.f32(r.tempC);
      break;
    case 'analog':
      w.f32(r.volts);
      break;
  }
}

function writeEdge(w: ByteWriter, e: GpioEdge): void {
  w.u8(e.gpio);
  w.u64(e.tUs);
  w.bool(e.level);
}

function writeDevice(w: ByteWriter, d: Device): void {
  w.string(d.instanceId);
  w.string(d.kind);
  w.array(d.pins, (pin) => {
    w.string(pin.name);
    w.u8(pin.gpio);
  });
  w.u8(d.defaultI2cAddress);
  w.u8(d.targetI2cAddress);
}

function writeNetEvent(w: ByteWriter, e: NetEvent): void {
  w.u8(code(NET_EVENT_TYPES, e.type, 'net event type', 1));
  switch (e.type) {
    case 'listen':
      w.u8(code(NET_PROTOS, e.proto, 'net proto'));
      w.u16(e.firmwarePort);
      w.u16(e.hostPort);
      w.string(e.bindAddress);
      break;
    case 'unlisten':
      w.u8(code(NET_PROTOS, e.proto, 'net proto'));
      w.u16(e.firmwarePort);
      break;
    case 'connect':
    case 'disconnect':
      w.u16(e.firmwarePort);
      w.string(e.peer);
      break;
  }
}

function writePayload(w: ByteWriter, m: Message): void {
  switch (m.type) {
    case 'HELLO':
      w.u16(m.protocolVersion);
      w.string(m.halVersion);
      return;
    case 'CONFIG':
      w.u16(m.protocolVersion);
      w.u32(m.tickUs);
      w.u32(m.seed);
      w.u32(m.halCallCostNs);
      w.u32(m.loopCostNs);
      w.string(m.net.bindAddress);
      w.array(m.devices, (d) => writeDevice(w, d));
      return;
    case 'STEP':
      w.u64(m.tick);
      w.u64(m.t0Us);
      w.u64(m.t1Us);
      w.array(m.readings, (r) => writeReading(w, r));
      w.array(m.gpioEdges, (e) => writeEdge(w, e));
      w.bytes(m.serialRx, LIMITS.serialBytes);
      if (m.netFaults) {
        w.u8(1);
        w.u32(m.netFaults.latencyUs);
        w.u32(m.netFaults.lossPpm);
        w.bool(m.netFaults.dropout);
      } else {
        w.u8(0);
      }
      return;
    case 'STEP_DONE':
      w.u64(m.tick);
      w.array(m.pwm, (p) => {
        w.u8(p.gpio);
        w.u32(p.periodUs);
        w.u32(p.pulseUs);
      });
      w.array(m.gpioWrites, (e) => writeEdge(w, e));
      w.bytes(m.serialTx, LIMITS.serialBytes);
      w.array(m.netEvents, (e) => writeNetEvent(w, e));
      w.array(
        m.logs,
        (line) => {
          w.u8(code(LOG_LEVELS, line.level, 'log level'));
          w.string(line.text);
        },
        LIMITS.logLines,
      );
      return;
    case 'BYE':
      w.u8(code(BYE_REASONS, m.reason, 'bye reason'));
      w.string(m.message);
      return;
  }
}

/** Encodes one message as a complete frame, length prefix included. */
export function encodeFrame(message: Message): Uint8Array {
  if (message.type === 'STEP' && message.netFaults && message.netFaults.lossPpm > 1_000_000) {
    throw new ProtocolError('malformed', 'netFaults.lossPpm must be at most 1000000');
  }
  const w = new ByteWriter();
  w.u32(0);
  w.u8(MESSAGE_TYPE_CODES[message.type]);
  writePayload(w, message);
  const length = w.length - 4;
  if (length > LIMITS.frameBytes) {
    throw new ProtocolError(
      'malformed',
      `frame is ${length} bytes; the limit is ${LIMITS.frameBytes}`,
    );
  }
  w.patchU32(0, length);
  return w.finish();
}

const readVec3 = (r: ByteReader): Vec3 => [r.f32(), r.f32(), r.f32()];

function readReading(r: ByteReader): Reading {
  const device = r.u16();
  const tUs = r.u64();
  const type = r.enum(READING_TYPES, 'reading type', 1);
  switch (type) {
    case 'distance':
      return {
        device,
        tUs,
        type,
        mm: r.u16(),
        status: r.enum(DISTANCE_STATUSES, 'distance status'),
      };
    case 'imu':
      return { device, tUs, type, accel: readVec3(r), gyro: readVec3(r), tempC: r.f32() };
    case 'analog':
      return { device, tUs, type, volts: r.f32() };
  }
}

const readEdge = (r: ByteReader): GpioEdge => ({ gpio: r.u8(), tUs: r.u64(), level: r.bool() });

function readNetEvent(r: ByteReader): NetEvent {
  const type = r.enum(NET_EVENT_TYPES, 'net event type', 1);
  switch (type) {
    case 'listen':
      return {
        type,
        proto: r.enum(NET_PROTOS, 'net proto'),
        firmwarePort: r.u16(),
        hostPort: r.u16(),
        bindAddress: r.string(),
      };
    case 'unlisten':
      return { type, proto: r.enum(NET_PROTOS, 'net proto'), firmwarePort: r.u16() };
    case 'connect':
    case 'disconnect':
      return { type, firmwarePort: r.u16(), peer: r.string() };
  }
}

function readPayload(r: ByteReader, type: MessageType): Message {
  switch (type) {
    case 'HELLO':
      return { type, protocolVersion: r.u16(), halVersion: r.string() };
    case 'CONFIG':
      return {
        type,
        protocolVersion: r.u16(),
        tickUs: r.u32(),
        seed: r.u32(),
        halCallCostNs: r.u32(),
        loopCostNs: r.u32(),
        net: { bindAddress: r.string() },
        devices: r.array(() => ({
          instanceId: r.string(),
          kind: r.string(),
          pins: r.array(() => ({ name: r.string(), gpio: r.u8() })),
          defaultI2cAddress: r.u8(),
          targetI2cAddress: r.u8(),
        })),
      };
    case 'STEP': {
      const step = {
        type,
        tick: r.u64(),
        t0Us: r.u64(),
        t1Us: r.u64(),
        readings: r.array(() => readReading(r)),
        gpioEdges: r.array(() => readEdge(r)),
        serialRx: r.bytes(LIMITS.serialBytes),
      };
      const netFaults = r.optional(() => ({
        latencyUs: r.u32(),
        lossPpm: r.u32(),
        dropout: r.bool(),
      }));
      if (netFaults && netFaults.lossPpm > 1_000_000) {
        throw new ProtocolError('malformed', 'netFaults.lossPpm must be at most 1000000');
      }
      return netFaults ? { ...step, netFaults } : step;
    }
    case 'STEP_DONE':
      return {
        type,
        tick: r.u64(),
        pwm: r.array(() => ({ gpio: r.u8(), periodUs: r.u32(), pulseUs: r.u32() })),
        gpioWrites: r.array(() => readEdge(r)),
        serialTx: r.bytes(LIMITS.serialBytes),
        netEvents: r.array(() => readNetEvent(r)),
        logs: r.array(
          () => ({ level: r.enum(LOG_LEVELS, 'log level'), text: r.string() }),
          LIMITS.logLines,
        ),
      };
    case 'BYE':
      return { type, reason: r.enum(BYE_REASONS, 'bye reason'), message: r.string() };
  }
}

/** Decodes the body of a frame (type byte + payload, no length prefix). */
export function decodeBody(body: Uint8Array): Message {
  const r = new ByteReader(body);
  const typeCode = r.u8();
  const type = TYPE_BY_CODE.get(typeCode);
  if (!type)
    throw new ProtocolError('malformed', `unknown message type 0x${typeCode.toString(16)}`);
  const message = readPayload(r, type);
  if (r.remaining > 0) {
    throw new ProtocolError('malformed', `${r.remaining} trailing bytes after ${type}`);
  }
  return message;
}

/** Decodes exactly one complete frame, length prefix included. */
export function decodeFrame(frame: Uint8Array): Message {
  const decoder = new FrameDecoder();
  const messages = decoder.push(frame);
  if (messages.length !== 1 || decoder.buffered > 0) {
    throw new ProtocolError(
      'malformed',
      messages.length === 0 ? 'incomplete frame' : 'more than one frame',
    );
  }
  return messages[0] as Message;
}

/**
 * Splits a byte stream into messages. Feed it socket chunks in order;
 * it returns every message completed so far and throws `ProtocolError`
 * on the first malformed frame.
 */
export class FrameDecoder {
  #pending = new Uint8Array(0);

  /** Bytes received but not yet part of a complete frame. */
  get buffered(): number {
    return this.#pending.length;
  }

  push(chunk: Uint8Array): Message[] {
    const joined = new Uint8Array(this.#pending.length + chunk.length);
    joined.set(this.#pending);
    joined.set(chunk, this.#pending.length);

    const messages: Message[] = [];
    let offset = 0;
    while (joined.length - offset >= 4) {
      const length = new DataView(joined.buffer, joined.byteOffset + offset, 4).getUint32(0, true);
      if (length < 1 || length > LIMITS.frameBytes) {
        throw new ProtocolError(
          'malformed',
          `frame length ${length} is outside 1..${LIMITS.frameBytes}`,
        );
      }
      if (joined.length - offset - 4 < length) break;
      messages.push(decodeBody(joined.subarray(offset + 4, offset + 4 + length)));
      offset += 4 + length;
    }
    this.#pending = joined.slice(offset);
    return messages;
  }
}
