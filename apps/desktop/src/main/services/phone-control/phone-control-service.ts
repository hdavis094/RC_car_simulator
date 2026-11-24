import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { networkInterfaces } from 'node:os';
import type { Duplex } from 'node:stream';
import { isNewerSeq, MAX_LINE_BYTES, parseClientLine } from '@rcsim/control-protocol';
import { WebSocket, WebSocketServer } from 'ws';
import {
  ipcErrorMessage,
  type ControlApi,
  type PhoneControlApi,
  type PhoneControlSession,
} from '../../../shared/ipc.ts';
import { Signal } from '../events.ts';
import { phoneAssets } from './phone-assets.ts';

const SUBPROTOCOL = 'rcsim.control.v1';
const SESSION_MS = 15 * 60_000;
const DRIVE_LEASE_MS = 250;

type Control = Pick<ControlApi, 'drive' | 'releaseDrive' | 'setMode' | 'estop' | 'onMessage'>;

interface Peer {
  readonly socket: WebSocket;
  sequence?: number;
  driveLease: ReturnType<typeof setTimeout> | undefined;
}

interface Session {
  readonly token: string;
  readonly http: Server;
  readonly websocket: WebSocketServer;
  readonly ready: PromiseWithResolvers<PhoneControlSession>;
  readonly listener: AbortController;
  readonly origins: Set<string>;
  unsubscribe: () => void;
  info: PhoneControlSession | null;
  peer: Peer | undefined;
  expiry: ReturnType<typeof setTimeout> | undefined;
}

function validToken(received: string | undefined, expected: string): boolean {
  if (received?.length !== expected.length) return false;
  const bytes = Buffer.from(received);
  const token = Buffer.from(expected);
  return bytes.length === token.length && timingSafeEqual(bytes, token);
}

function rejectUpgrade(socket: Duplex, status: '403 Forbidden' | '409 Conflict'): void {
  socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

export class PhoneControlService implements PhoneControlApi {
  private readonly changes = new Signal<[PhoneControlSession | null]>();
  readonly onStatus = this.changes.subscribe;
  private session: Session | undefined;
  private readonly control: Control;
  private readonly bindAddress: '0.0.0.0' | '127.0.0.1';
  private readonly sessionMs: number;

  constructor(
    control: Control,
    options: { bindAddress?: '0.0.0.0' | '127.0.0.1'; sessionMs?: number } = {},
  ) {
    this.control = control;
    this.bindAddress = options.bindAddress ?? '0.0.0.0';
    this.sessionMs = options.sessionMs ?? SESSION_MS;
  }

  async start(): Promise<PhoneControlSession> {
    if (this.session) return this.session.ready.promise;
    const ready = Promise.withResolvers<PhoneControlSession>();
    const server = createServer({ headersTimeout: 5000, requestTimeout: 5000 }, (req, res) => {
      const asset = req.method === 'GET' ? phoneAssets.get(req.url ?? '') : undefined;
      if (!asset || !session.origins.has(`http://${req.headers.host}`)) {
        res.writeHead(404).end();
        return;
      }
      res
        .writeHead(200, {
          'Content-Type': asset.contentType,
          'Cache-Control': 'no-store',
          'Content-Security-Policy':
            "default-src 'none'; script-src 'self'; style-src 'self'; connect-src ws:; frame-ancestors 'none'; base-uri 'none'",
          'Referrer-Policy': 'no-referrer',
          'X-Content-Type-Options': 'nosniff',
        })
        .end(asset.body);
    });
    const websocket = new WebSocketServer({
      noServer: true,
      maxPayload: MAX_LINE_BYTES,
      handleProtocols: () => SUBPROTOCOL,
    });
    const session: Session = {
      token: randomBytes(32).toString('base64url'),
      http: server,
      websocket,
      ready,
      listener: new AbortController(),
      origins: new Set(),
      unsubscribe: () => {},
      info: null,
      peer: undefined,
      expiry: undefined,
    };
    this.session = session;
    websocket.on('error', () => this.close(session));
    server.on('error', (error) => {
      ready.reject(error);
      this.close(session);
    });
    server.on('upgrade', (request, socket, head) => this.upgrade(session, request, socket, head));
    try {
      server.listen({ host: this.bindAddress, port: 0, signal: session.listener.signal }, () => {
        if (this.session !== session) return;
        const address = server.address();
        if (!address || typeof address === 'string') {
          this.close(session);
          return;
        }
        for (const host of this.hosts()) session.origins.add(`http://${host}:${address.port}`);
        const info = {
          urls: [...session.origins].map((origin) => `${origin}/#${session.token}`),
          expiresAt: Date.now() + this.sessionMs,
        };
        session.info = info;
        session.expiry = setTimeout(() => this.close(session), this.sessionMs);
        session.unsubscribe = this.control.onMessage((message) => {
          const socket = session.peer?.socket;
          if (socket?.readyState === WebSocket.OPEN && socket.bufferedAmount < 64_000) {
            socket.send(JSON.stringify(message));
          }
        });
        ready.resolve(info);
        this.changes.emit(info);
      });
    } catch (error) {
      ready.reject(error);
      this.close(session);
    }
    return ready.promise;
  }

  async status(): Promise<PhoneControlSession | null> {
    return this.session?.info ?? null;
  }

  async stop(): Promise<void> {
    this.dispose();
  }

  dispose(): void {
    if (this.session) this.close(this.session);
  }

  private hosts(): readonly string[] {
    if (this.bindAddress === '127.0.0.1') return [this.bindAddress];
    const addresses = Object.values(networkInterfaces()).flatMap((interfaces) =>
      (interfaces ?? []).flatMap((entry) =>
        entry.family === 'IPv4' && !entry.internal ? [entry.address] : [],
      ),
    );
    return [...new Set([...addresses, '127.0.0.1'])];
  }

  private upgrade(session: Session, request: IncomingMessage, socket: Duplex, head: Buffer): void {
    const [protocol, token, extra] = (request.headers['sec-websocket-protocol'] ?? '')
      .split(',')
      .map((part) => part.trim());
    const origin = `http://${request.headers.host}`;
    if (
      this.session !== session ||
      !session.info ||
      Date.now() >= session.info.expiresAt ||
      request.url !== '/control' ||
      !session.origins.has(origin) ||
      request.headers.origin !== origin ||
      protocol !== SUBPROTOCOL ||
      extra !== undefined ||
      !validToken(token, session.token)
    ) {
      rejectUpgrade(socket, '403 Forbidden');
      return;
    }
    if (session.peer) {
      rejectUpgrade(socket, '409 Conflict');
      return;
    }
    session.websocket.handleUpgrade(request, socket, head, (client) => {
      const peer: Peer = { socket: client, driveLease: undefined };
      session.peer = peer;
      client.on('error', () => client.terminate());
      client.on('close', () => {
        if (session.peer === peer) session.peer = undefined;
        this.release(peer);
      });
      client.on('message', (data, binary) => {
        if (this.session !== session || session.peer !== peer) return;
        if (binary || !Buffer.isBuffer(data)) {
          client.close(1003, 'Expected a JSON text message');
          return;
        }
        this.command(peer, data.toString('utf8'));
      });
    });
  }

  private command(peer: Peer, text: string): void {
    const parsed = parseClientLine(text);
    if (!parsed.ok) {
      peer.socket.close(1008, 'Invalid control command');
      return;
    }
    const command = parsed.message;
    if (command.t === 'drive') {
      if (!isNewerSeq(command.seq, peer.sequence)) return;
      peer.sequence = command.seq;
      clearTimeout(peer.driveLease);
      if (command.throttle === 0 && command.steer === 0) {
        this.release(peer);
        return;
      }
      peer.driveLease = setTimeout(() => this.release(peer), DRIVE_LEASE_MS);
      void this.control.drive(command).catch(() => this.release(peer));
      return;
    }
    this.release(peer);
    const result = command.t === 'mode' ? this.control.setMode(command.mode) : this.control.estop();
    void result.catch(() => peer.socket.close(1011, 'Car command failed'));
  }

  private release(peer: Peer): void {
    if (!peer.driveLease) return;
    clearTimeout(peer.driveLease);
    peer.driveLease = undefined;
    void this.control.drive({ throttle: 0, steer: 0 }).catch(() => {});
    void this.control.releaseDrive().catch(() => {});
  }

  private close(session: Session): void {
    if (this.session !== session) return;
    this.session = undefined;
    clearTimeout(session.expiry);
    session.unsubscribe();
    if (session.peer) {
      this.release(session.peer);
      session.peer.socket.terminate();
    }
    session.listener.abort();
    session.http.closeAllConnections();
    session.websocket.close();
    if (session.info) this.changes.emit(null);
    else
      session.ready.reject(
        new Error(ipcErrorMessage('io', 'Phone control stopped before its server started.')),
      );
  }
}
