import type { Socket } from 'node:net';
import { FrameDecoder, ProtocolError, encodeFrame, type Message } from '@rcsim/sim-protocol';

/** What a `Channel` hands its reader, one at a time and in order. */
export type ChannelEvent =
  | { readonly kind: 'message'; readonly message: Message }
  /** The peer sent bytes that are not a valid frame; a BYE(malformed) has been sent. */
  | { readonly kind: 'malformed'; readonly reason: string }
  | { readonly kind: 'closed' };

/**
 * One sim-protocol connection: frames in, frames out. Messages and the end
 * of the connection are queued, so a reader that is busy elsewhere loses none
 * of them. After `closed` (or `malformed`), `next()` keeps answering `closed`.
 */
export class Channel {
  readonly #socket: Socket;
  readonly #decoder = new FrameDecoder();
  readonly #queue: ChannelEvent[] = [];
  #waiter: ((event: ChannelEvent) => void) | undefined;
  #closed = false;

  constructor(socket: Socket) {
    this.#socket = socket;
    socket.on('data', (chunk: Buffer) => this.#onData(chunk));
    // An error always precedes or accompanies 'close'; the reader sees `closed`.
    socket.on('error', () => this.#close());
    socket.on('close', () => this.#close());
  }

  get closed(): boolean {
    return this.#closed;
  }

  /** The next event; resolves with `closed` forever once the connection is gone. */
  next(): Promise<ChannelEvent> {
    const queued = this.#queue.shift();
    if (queued) return Promise.resolve(queued);
    if (this.#closed) return Promise.resolve({ kind: 'closed' });
    return new Promise((resolve) => {
      this.#waiter = resolve;
    });
  }

  /** Writes one frame. Resolves false when the connection is gone (the write is dropped). */
  send(message: Message): Promise<boolean> {
    if (this.#closed || this.#socket.destroyed || !this.#socket.writable) {
      return Promise.resolve(false);
    }
    const frame = encodeFrame(message); // throws ProtocolError for an oversize message
    return new Promise((resolve) => {
      this.#socket.write(frame, (error) => resolve(error == null));
    });
  }

  /** Closes the connection after flushing what was written. */
  end(): void {
    if (!this.#socket.destroyed) this.#socket.end();
  }

  destroy(): void {
    this.#socket.destroy();
    this.#close();
  }

  #push(event: ChannelEvent): void {
    const waiter = this.#waiter;
    if (waiter) {
      this.#waiter = undefined;
      waiter(event);
    } else {
      this.#queue.push(event);
    }
  }

  #onData(chunk: Uint8Array): void {
    if (this.#closed) return;
    try {
      for (const message of this.#decoder.push(chunk)) this.#push({ kind: 'message', message });
    } catch (error) {
      if (!(error instanceof ProtocolError)) throw error;
      for (const message of error.decoded) this.#push({ kind: 'message', message });
      this.#push({ kind: 'malformed', reason: error.message });
      void this.send({ type: 'BYE', reason: 'malformed', message: error.message }).then(() =>
        this.end(),
      );
      this.#closed = true;
    }
  }

  #close(): void {
    this.#closed = true;
    const waiter = this.#waiter;
    if (waiter) {
      this.#waiter = undefined;
      waiter({ kind: 'closed' });
    }
  }
}
