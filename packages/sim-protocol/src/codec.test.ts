import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FrameDecoder, decodeFrame, encodeFrame } from './codec.ts';
import { messageFromJson, messageToJson, type VectorJson } from './json.ts';
import { LIMITS, MESSAGE_TYPE_CODES, ProtocolError, type Message } from './protocol.ts';

const vectorsDir = join(import.meta.dirname, '..', 'vectors');
const names = (dir: string): string[] =>
  readdirSync(dir)
    .filter((f) => f.endsWith('.bin'))
    .map((f) => f.slice(0, -'.bin'.length))
    .sort();
const bin = (dir: string, name: string): Uint8Array =>
  new Uint8Array(readFileSync(join(dir, `${name}.bin`)));
const json = (dir: string, name: string): unknown =>
  JSON.parse(readFileSync(join(dir, `${name}.json`), 'utf8'));

const valid = names(vectorsDir);
const malformedDir = join(vectorsDir, 'malformed');
const malformed = names(malformedDir);

describe('golden vectors', () => {
  it('cover every message type', () => {
    const types = new Set(valid.map((name) => (json(vectorsDir, name) as VectorJson).type));
    expect(types).toEqual(new Set(Object.keys(MESSAGE_TYPE_CODES)));
  });

  it.each(valid)('%s.bin decodes to %s.json', (name) => {
    expect(messageToJson(decodeFrame(bin(vectorsDir, name)))).toEqual(json(vectorsDir, name));
  });

  it.each(valid)('%s.json encodes to %s.bin byte for byte', (name) => {
    const encoded = encodeFrame(messageFromJson(json(vectorsDir, name) as VectorJson));
    expect(Buffer.from(encoded).equals(Buffer.from(bin(vectorsDir, name)))).toBe(true);
  });

  it.each(malformed)('malformed/%s.bin is rejected for its own reason', (name) => {
    let error: unknown;
    try {
      decodeFrame(bin(malformedDir, name));
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ProtocolError);
    expect((error as ProtocolError).reason).toBe('malformed');
    // Each vector breaks one rule; it must not merely run out of bytes first.
    if (!name.startsWith('truncated') && name !== 'zero-length') {
      expect((error as ProtocolError).message).not.toMatch(/truncated|incomplete/);
    }
  });
});

describe('frame layout', () => {
  it('matches SPEC.md byte for byte for a HELLO', () => {
    const frame = encodeFrame({ type: 'HELLO', protocolVersion: 1, halVersion: 'ab' });
    // length 7 = type(1) + u16 version(2) + u16 strlen(2) + "ab"(2)
    expect([...frame]).toEqual([7, 0, 0, 0, 0x01, 1, 0, 2, 0, 0x61, 0x62]);
  });

  it('writes u64 times little-endian', () => {
    const frame = encodeFrame({
      type: 'STEP',
      tick: 0x0102,
      t0Us: 0,
      t1Us: 1000,
      readings: [],
      gpioEdges: [],
      serialRx: new Uint8Array(0),
    });
    expect([...frame.subarray(5, 13)]).toEqual([0x02, 0x01, 0, 0, 0, 0, 0, 0]);
  });
});

describe('FrameDecoder', () => {
  const messages = valid.map((name) => decodeFrame(bin(vectorsDir, name)));
  const stream = Buffer.concat(valid.map((name) => bin(vectorsDir, name)));

  it('splits a stream fed one byte at a time', () => {
    const decoder = new FrameDecoder();
    const out: Message[] = [];
    for (const byte of stream) out.push(...decoder.push(Uint8Array.of(byte)));
    expect(out).toEqual(messages);
    expect(decoder.buffered).toBe(0);
  });

  it('splits a stream fed in one chunk', () => {
    expect(new FrameDecoder().push(stream)).toEqual(messages);
  });

  it('rejects a bad length before the body arrives', () => {
    const header = new Uint8Array(4);
    new DataView(header.buffer).setUint32(0, LIMITS.frameBytes + 1, true);
    expect(() => new FrameDecoder().push(header)).toThrow(/outside/);
  });

  it('rejects an incomplete frame in decodeFrame', () => {
    const frame = bin(vectorsDir, 'hello');
    expect(() => decodeFrame(frame.subarray(0, frame.length - 1))).toThrow(/incomplete/);
  });
});

describe('encodeFrame', () => {
  const step = (overrides: Partial<Extract<Message, { type: 'STEP' }>>): Message => ({
    type: 'STEP',
    tick: 0,
    t0Us: 0,
    t1Us: 1000,
    readings: [],
    gpioEdges: [],
    serialRx: new Uint8Array(0),
    ...overrides,
  });

  it.each([
    ['a u64 above 2^53 - 1', step({ tick: Number.MAX_SAFE_INTEGER + 2 })],
    ['a negative time', step({ t0Us: -1 })],
    ['a fractional tick', step({ tick: 1.5 })],
    ['serial bytes over the limit', step({ serialRx: new Uint8Array(LIMITS.serialBytes + 1) })],
    ['a GPIO above 255', step({ gpioEdges: [{ gpio: 256, tUs: 0, level: true }] })],
    [
      'lossPpm over a million',
      step({ netFaults: { latencyUs: 0, lossPpm: 1_000_001, dropout: false } }),
    ],
    [
      'a non-finite f32',
      step({ readings: [{ device: 0, tUs: 0, type: 'analog', volts: Number.NaN }] }),
    ],
    [
      'a string over 1024 bytes',
      { type: 'HELLO', protocolVersion: 1, halVersion: 'é'.repeat(513) },
    ],
  ] as [string, Message][])('rejects %s', (_, message) => {
    expect(() => encodeFrame(message)).toThrow(ProtocolError);
  });

  it('rounds f32 fields to binary32', () => {
    const frame = encodeFrame(
      step({ readings: [{ device: 0, tUs: 0, type: 'analog', volts: 0.1 }] }),
    );
    const decoded = decodeFrame(frame) as Extract<Message, { type: 'STEP' }>;
    expect(decoded.readings[0]).toMatchObject({ volts: Math.fround(0.1) });
  });
});
