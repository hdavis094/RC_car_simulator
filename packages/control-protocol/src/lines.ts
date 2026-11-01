import { MAX_LINE_BYTES } from './messages.ts';

/**
 * Splits a byte stream into protocol lines. A line longer than
 * MAX_LINE_BYTES is dropped whole and reported through `onOverflow`.
 */
export class LineSplitter {
  readonly #decoder = new TextDecoder();
  #pending = '';
  #overflowing = false;
  readonly #onOverflow: (bytes: number) => void;

  constructor(onOverflow: (bytes: number) => void = () => {}) {
    this.#onOverflow = onOverflow;
  }

  push(chunk: Uint8Array): string[] {
    const text = this.#pending + this.#decoder.decode(chunk, { stream: true });
    const parts = text.split('\n');
    this.#pending = parts.pop() ?? '';
    const lines: string[] = [];
    for (const part of parts) {
      if (this.#overflowing) {
        this.#overflowing = false;
        continue;
      }
      const line = part.endsWith('\r') ? part.slice(0, -1) : part;
      if (Buffer.byteLength(line) + 1 > MAX_LINE_BYTES) {
        this.#onOverflow(Buffer.byteLength(line) + 1);
        continue;
      }
      if (line.length > 0) lines.push(line);
    }
    if (Buffer.byteLength(this.#pending) + 1 > MAX_LINE_BYTES) {
      if (!this.#overflowing) this.#onOverflow(Buffer.byteLength(this.#pending) + 1);
      this.#overflowing = true;
      this.#pending = '';
    }
    return lines;
  }
}
