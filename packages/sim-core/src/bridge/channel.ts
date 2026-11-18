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
  readonly #accept: ((message: Message) => string | undefined) | undefined;
  readonly #decoder = new FrameDecoder();
  readonly #queue: ChannelEvent[] = [];
  #waiter: ((event: ChannelEvent) => void) | undefined;
  #closed = false;

  /**
   * `accept` judges each message at the moment it is decoded, against the
   * state of the protocol then (not when a reader gets round to it): it
   * returns a reason when the message may not arrive now. The channel then
   * reports `malformed`, sends BYE(malformed), and drops everything after it.
   */
  constructor(socket: Socket, accept?: (message: Message) => string | undefined) {
    this.#socket = socket;
    this.#accept = accept;
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
    return this.sendFrame(encodeFrame(message)); // throws ProtocolError for an oversize message
  }

  /**
   * Writes an encoded frame. The promise settles when the frame has been
   * handed to the kernel, which takes as long as the peer needs to make room
   * when its buffers are full: a caller that must not wait forever bounds it.
   */
  sendFrame(frame: Uint8Array): Promise<boolean> {
    if (this.#closed || this.#socket.destroyed || !this.#socket.writable) {
      return Promise.resolve(false);
    }
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
    let decoded: readonly Message[];
    let malformed: string | undefined;
    try {
      decoded = this.#decoder.push(chunk);
    } catch (error) {
      if (!(error instanceof ProtocolError)) throw error;
      // The frames completed before the bad one are judged like any others,
      // in order: the first violation, wherever it is, ends the connection.
      decoded = error.decoded;
      malformed = error.message;
    }
    for (const message of decoded) {
      const reason = this.#accept?.(message);
      if (reason !== undefined) {
        this.#reject(reason);
        return;
      }
      this.#push({ kind: 'message', message });
    }
    if (malformed !== undefined) this.#reject(malformed);
  }

  /** A protocol violation: tell the peer, report it to the reader, accept nothing more. */
  #reject(reason: string): void {
    this.#push({ kind: 'malformed', reason });
    void this.send({ type: 'BYE', reason: 'malformed', message: reason }).then(() => this.end());
    this.#closed = true;
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
