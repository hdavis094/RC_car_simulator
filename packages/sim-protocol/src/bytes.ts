import { LIMITS, ProtocolError } from './protocol.ts';

const malformed = (message: string): ProtocolError => new ProtocolError('malformed', message);
const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder('utf-8', { fatal: true });

/** Appends little-endian primitives to a growing buffer. Checks every limit in SPEC.md. */
export class ByteWriter {
  #buffer = new Uint8Array(256);
  #view = new DataView(this.#buffer.buffer);
  #length = 0;

  get length(): number {
    return this.#length;
  }

  #reserve(bytes: number): number {
    const needed = this.#length + bytes;
    if (needed > this.#buffer.length) {
      let size = this.#buffer.length * 2;
      while (size < needed) size *= 2;
      const next = new Uint8Array(size);
      next.set(this.#buffer.subarray(0, this.#length));
      this.#buffer = next;
      this.#view = new DataView(next.buffer);
    }
    const at = this.#length;
    this.#length = needed;
    return at;
  }

  #int(value: number, max: number, what: string): void {
    if (!Number.isInteger(value) || value < 0 || value > max) {
      throw malformed(`${what} must be an integer in 0..${max}, got ${value}`);
    }
  }

  u8(value: number): void {
    this.#int(value, 0xff, 'u8');
    const at = this.#reserve(1);
    this.#view.setUint8(at, value);
  }

  u16(value: number): void {
    this.#int(value, 0xffff, 'u16');
    const at = this.#reserve(2);
    this.#view.setUint16(at, value, true);
  }

  u32(value: number): void {
    this.#int(value, 0xffff_ffff, 'u32');
    const at = this.#reserve(4);
    this.#view.setUint32(at, value, true);
  }

  u64(value: number): void {
    this.#int(value, Number.MAX_SAFE_INTEGER, 'u64');
    const at = this.#reserve(8);
    this.#view.setBigUint64(at, BigInt(value), true);
  }

  f32(value: number): void {
    if (!Number.isFinite(value)) throw malformed(`f32 must be finite, got ${value}`);
    const at = this.#reserve(4);
    this.#view.setFloat32(at, value, true);
  }

  bool(value: boolean): void {
    this.u8(value ? 1 : 0);
  }

  string(value: string): void {
    const bytes = utf8Encoder.encode(value);
    if (bytes.length > LIMITS.stringBytes) {
      throw malformed(`string is ${bytes.length} bytes; the limit is ${LIMITS.stringBytes}`);
    }
    this.u16(bytes.length);
    this.raw(bytes);
  }

  bytes(value: Uint8Array, limit: number): void {
    if (value.length > limit) throw malformed(`${value.length} bytes; the limit is ${limit}`);
    this.u32(value.length);
    this.raw(value);
  }

  array<T>(
    items: readonly T[],
    write: (item: T) => void,
    limit: number = LIMITS.arrayLength,
  ): void {
    if (items.length > limit) throw malformed(`array of ${items.length}; the limit is ${limit}`);
    this.u16(items.length);
    for (const item of items) write(item);
  }

  raw(bytes: Uint8Array): void {
    const at = this.#reserve(bytes.length); // may replace #buffer, so reserve first
    this.#buffer.set(bytes, at);
  }

  /** Writes a u32 at an earlier offset (used for the frame length). */
  patchU32(offset: number, value: number): void {
    this.#view.setUint32(offset, value, true);
  }

  finish(): Uint8Array {
    return this.#buffer.slice(0, this.#length);
  }
}

/** Reads little-endian primitives, rejecting truncation and every limit violation. */
export class ByteReader {
  readonly #bytes: Uint8Array;
  readonly #view: DataView;
  #offset = 0;

  constructor(bytes: Uint8Array) {
    this.#bytes = bytes;
    this.#view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  get remaining(): number {
    return this.#bytes.length - this.#offset;
  }

  #take(count: number, what: string): number {
    if (this.remaining < count) {
      throw malformed(`truncated: ${what} needs ${count} bytes, ${this.remaining} left`);
    }
    const at = this.#offset;
    this.#offset += count;
    return at;
  }

  u8(): number {
    return this.#view.getUint8(this.#take(1, 'u8'));
  }

  u16(): number {
    return this.#view.getUint16(this.#take(2, 'u16'), true);
  }

  u32(): number {
    return this.#view.getUint32(this.#take(4, 'u32'), true);
  }

  u64(): number {
    const value = this.#view.getBigUint64(this.#take(8, 'u64'), true);
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw malformed(`u64 ${value} is above 2^53 - 1`);
    }
    return Number(value);
  }

  f32(): number {
    const value = this.#view.getFloat32(this.#take(4, 'f32'), true);
    if (!Number.isFinite(value)) throw malformed('f32 is not finite');
    return value;
  }

  bool(): boolean {
    const value = this.u8();
    if (value > 1) throw malformed(`bool must be 0 or 1, got ${value}`);
    return value === 1;
  }

  enum<T>(values: readonly T[], what: string, firstCode = 0): T {
    const code = this.u8();
    const value = values[code - firstCode];
    if (value === undefined) throw malformed(`unknown ${what} ${code}`);
    return value;
  }

  string(): string {
    const length = this.u16();
    if (length > LIMITS.stringBytes) {
      throw malformed(`string is ${length} bytes; the limit is ${LIMITS.stringBytes}`);
    }
    const at = this.#take(length, 'string');
    try {
      return utf8Decoder.decode(this.#bytes.subarray(at, at + length));
    } catch {
      throw malformed('string is not valid UTF-8');
    }
  }

  bytes(limit: number): Uint8Array {
    const length = this.u32();
    if (length > limit) throw malformed(`${length} bytes; the limit is ${limit}`);
    const at = this.#take(length, 'bytes');
    return this.#bytes.slice(at, at + length);
  }

  array<T>(read: () => T, limit: number = LIMITS.arrayLength): T[] {
    const count = this.u16();
    if (count > limit) throw malformed(`array of ${count}; the limit is ${limit}`);
    const items: T[] = [];
    for (let i = 0; i < count; i++) items.push(read());
    return items;
  }

  optional<T>(read: () => T): T | undefined {
    const flag = this.u8();
    if (flag > 1) throw malformed(`optional flag must be 0 or 1, got ${flag}`);
    return flag === 1 ? read() : undefined;
  }
}
