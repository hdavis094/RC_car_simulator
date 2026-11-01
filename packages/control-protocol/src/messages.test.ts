import { describe, expect, it } from 'vitest';
import { LineSplitter } from './lines.ts';
import { encodeLine, isNewerSeq, parseCarLine, parseClientLine } from './messages.ts';

describe('messages', () => {
  it('parses the telemetry example from SPEC.md', () => {
    const result = parseCarLine(
      '{"t":"telemetry","ms":1234,"mode":"auto","estop":false,"throttle":0.3,"steer":0.1,"tof_mm":[812,1200,640],"batt_mv":7810,"yaw_dps":12.5}',
    );
    expect(result).toMatchObject({
      ok: true,
      message: { tof_mm: [812, 1200, 640], batt_mv: 7810 },
    });
  });

  it('clamps drive values and strips unknown fields', () => {
    expect(parseClientLine('{"t":"drive","seq":1,"throttle":1.5,"steer":-9,"x":1}')).toEqual({
      ok: true,
      message: { t: 'drive', seq: 1, throttle: 1, steer: -1 },
    });
  });

  it('rejects non-objects, missing t, unknown types and non-numbers', () => {
    for (const line of [
      '[1]',
      '"x"',
      '{"seq":1}',
      '{"t":"warp"}',
      '{"t":"drive","seq":1,"throttle":"a","steer":0}',
    ]) {
      expect(parseClientLine(line).ok, line).toBe(false);
    }
  });

  it('encodes one line with a trailing newline', () => {
    expect(encodeLine({ t: 'estop' })).toBe('{"t":"estop"}\n');
  });

  it('compares sequence numbers across the 32-bit wrap', () => {
    expect(isNewerSeq(5, undefined)).toBe(true);
    expect(isNewerSeq(6, 5)).toBe(true);
    expect(isNewerSeq(5, 5)).toBe(false);
    expect(isNewerSeq(4, 5)).toBe(false);
    expect(isNewerSeq(0, 0xffff_ffff)).toBe(true);
    expect(isNewerSeq(0xffff_ffff, 0)).toBe(false);
  });
});

describe('LineSplitter', () => {
  it('reassembles lines split across chunks, multi-byte characters included', () => {
    const splitter = new LineSplitter();
    const bytes = new TextEncoder().encode('{"t":"log","msg":"é"}\r\n{"t":"estop"}\n');
    const lines: string[] = [];
    for (const byte of bytes) lines.push(...splitter.push(Uint8Array.of(byte)));
    expect(lines).toEqual(['{"t":"log","msg":"é"}', '{"t":"estop"}']);
  });

  it('counts CR toward the limit the same way however TCP splits the line', () => {
    const line = `{"t":"estop"}${' '.repeat(4096 - 14)}\r\n`; // 4097 bytes on the wire
    const whole = new LineSplitter().push(new TextEncoder().encode(line));
    const splitter = new LineSplitter();
    const bytewise = [...new TextEncoder().encode(line)].flatMap((b) =>
      splitter.push(Uint8Array.of(b)),
    );
    expect(whole).toEqual([]);
    expect(bytewise).toEqual([]);
  });

  it('drops an over-long line whole and keeps going', () => {
    const overflows: number[] = [];
    const splitter = new LineSplitter((bytes) => overflows.push(bytes));
    const long = 'x'.repeat(5000);
    const out = [
      ...splitter.push(new TextEncoder().encode(long.slice(0, 3000))),
      ...splitter.push(new TextEncoder().encode(`${long.slice(3000)}\n{"t":"estop"}\n`)),
    ];
    expect(out).toEqual(['{"t":"estop"}']);
    expect(overflows).toHaveLength(1);
  });
});
