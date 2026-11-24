import { createConnection, createServer, type Socket } from 'node:net';
import { LineSplitter } from '@rcsim/control-protocol';

type Direction = 'in' | 'out';

/** Carries raw Network Console lines over the same car connection as ControlClient. */
export class ControlWire {
  private readonly server = createServer((socket) => this.relay(socket));
  private local: Socket | undefined;
  private remote: Socket | undefined;
  private closed = false;

  private readonly target: { readonly host: string; readonly port: number };
  private readonly onRaw: (line: string, direction: Direction) => void;
  private readonly onReady: () => void;

  constructor(
    target: ControlWire['target'],
    onRaw: ControlWire['onRaw'],
    onReady: ControlWire['onReady'],
  ) {
    this.target = target;
    this.onRaw = onRaw;
    this.onReady = onReady;
  }

  async listen(): Promise<number> {
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    const error = (cause: Error): void => reject(cause);
    this.server.once('error', error);
    this.server.listen(0, '127.0.0.1', resolve);
    try {
      await promise;
      const address = this.server.address();
      if (!address || typeof address === 'string') throw new Error('Control relay did not bind.');
      return address.port;
    } finally {
      this.server.off('error', error);
      if (this.closed) this.server.close();
    }
  }

  get ready(): boolean {
    return this.remote !== undefined && !this.remote.connecting && !this.remote.destroyed;
  }

  sendRaw(line: string): boolean {
    const remote = this.remote;
    if (!remote || !this.ready) return false;
    remote.write(`${line}\n`);
    this.onRaw(line, 'out');
    return true;
  }

  private relay(local: Socket): void {
    if (this.closed || this.local) {
      local.destroy();
      return;
    }
    this.local = local;
    const remote = createConnection(this.target);
    this.remote = remote;
    remote.setNoDelay(true);
    const incoming = new LineSplitter();
    const outgoing = new LineSplitter();
    const timeout = setTimeout(() => remote.destroy(), 3000);
    const close = (): void => {
      clearTimeout(timeout);
      if (this.local === local) {
        this.local = this.remote = undefined;
      }
      local.destroy();
      remote.destroy();
    };
    local.on('error', close).once('close', close);
    remote.on('error', close).once('close', close);
    remote.once('connect', () => {
      clearTimeout(timeout);
      this.onReady();
    });
    local.on('data', (chunk: Buffer) => {
      for (const line of outgoing.push(chunk)) this.onRaw(line, 'out');
    });
    remote.on('data', (chunk: Buffer) => {
      for (const line of incoming.push(chunk)) this.onRaw(line, 'in');
    });
    local.pipe(remote);
    remote.pipe(local);
  }

  close(): void {
    this.closed = true;
    this.local?.destroy();
    this.remote?.destroy();
    if (this.server.listening) this.server.close();
  }
}
