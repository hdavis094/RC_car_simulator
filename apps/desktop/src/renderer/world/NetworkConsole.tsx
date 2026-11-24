import {
  parseCarLine,
  type ConnectionState,
  type Hello,
  type Log,
  type Telemetry,
} from '@rcsim/control-protocol/messages';
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { parseIpcError, type RcsimApi } from '../../shared/ipc.ts';
import { useSessionStore } from '../shell/session.ts';
import { PhoneControl } from './PhoneControl.tsx';

export const MAX_CONSOLE_ENTRIES = 500;

export interface RawConsoleEntry {
  readonly id: number;
  readonly direction: 'in' | 'out';
  readonly raw: string;
  readonly formatted: string;
}

export function formatIncomingLine(line: string): string {
  const trimmed = line.trim();
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return JSON.stringify(parsed, null, 2);
  } catch {
    return trimmed;
  }
}

interface ControlLinkSnapshot {
  readonly connectionState: ConnectionState;
  readonly hello: Hello | null;
  readonly telemetry: Telemetry | null;
  readonly entries: readonly RawConsoleEntry[];
}

interface ControlTracker {
  getSnapshot(): ControlLinkSnapshot;
  subscribe(listener: () => void): () => void;
  clearEntries(): void;
}

const trackersByApi = new WeakMap<RcsimApi, ControlTracker>();

function ensureControlTracker(api: RcsimApi): ControlTracker {
  const existing = trackersByApi.get(api);
  if (existing) return existing;

  let snapshot: ControlLinkSnapshot = {
    connectionState: 'idle',
    hello: null,
    telemetry: null,
    entries: [],
  };
  let nextId = 1;
  const subscribers = new Set<() => void>();

  const notify = (): void => {
    for (const sub of subscribers) sub();
  };

  api.control.onState((nextState) => {
    if (snapshot.connectionState === nextState) return;
    snapshot = {
      ...snapshot,
      connectionState: nextState,
    };
    notify();
  });

  api.control.onMessage((msg: Hello | Telemetry | Log) => {
    const nextConn: ConnectionState =
      snapshot.connectionState === 'idle' || snapshot.connectionState === 'connecting'
        ? 'connected'
        : snapshot.connectionState;
    snapshot = {
      ...snapshot,
      connectionState: nextConn,
      telemetry: msg.t === 'telemetry' ? msg : snapshot.telemetry,
      hello: msg.t === 'hello' ? msg : snapshot.hello,
    };
    notify();
  });

  api.control.onRaw((rawLine, direction) => {
    const nextConn: ConnectionState =
      snapshot.connectionState === 'idle' || snapshot.connectionState === 'connecting'
        ? 'connected'
        : snapshot.connectionState;
    let nextTelemetry = snapshot.telemetry;
    let nextHello = snapshot.hello;
    if (direction === 'in') {
      const parsed = parseCarLine(rawLine.trim());
      if (parsed.ok) {
        if (parsed.message.t === 'telemetry') nextTelemetry = parsed.message;
        else if (parsed.message.t === 'hello') nextHello = parsed.message;
      }
    }
    const entry: RawConsoleEntry = {
      id: nextId++,
      direction,
      raw: rawLine.trim(),
      formatted: direction === 'in' ? formatIncomingLine(rawLine) : rawLine.trim(),
    };
    const nextEntries =
      snapshot.entries.length >= MAX_CONSOLE_ENTRIES
        ? [...snapshot.entries.slice(snapshot.entries.length - MAX_CONSOLE_ENTRIES + 1), entry]
        : [...snapshot.entries, entry];

    snapshot = {
      connectionState: nextConn,
      hello: nextHello,
      telemetry: nextTelemetry,
      entries: nextEntries,
    };
    notify();
  });

  const tracker: ControlTracker = {
    getSnapshot() {
      return snapshot;
    },
    subscribe(listener) {
      subscribers.add(listener);
      return () => {
        subscribers.delete(listener);
      };
    },
    clearEntries() {
      snapshot = {
        ...snapshot,
        entries: [],
      };
      notify();
    },
  };
  trackersByApi.set(api, tracker);
  return tracker;
}

/** Prime the per-API control tracker so connection state and raw history are captured from startup. */
export function primeControlLinkTracker(api: RcsimApi): void {
  ensureControlTracker(api);
}

const noopSubscribe = (): (() => void) => () => {};

export interface NetworkConsoleProps {
  readonly api?: RcsimApi;
  readonly visible?: boolean;
}

export function NetworkConsole({ api = window.rcsim, visible }: NetworkConsoleProps): ReactNode {
  const sessionVisible = useSessionStore((s) => s.panelOpen && s.panel === 'network');
  const isVisible = visible ?? sessionVisible;

  const tracker = ensureControlTracker(api);

  // While hidden, use a no-op subscription and cached initial snapshot so incoming 50 Hz telemetry
  // buffers in `tracker` without re-rendering `NetworkConsole`. When `isVisible` becomes true,
  // `useSyncExternalStore` reads the live buffered snapshot and subscribes to live updates.
  const [hiddenInitialSnapshot] = useState<ControlLinkSnapshot>(() => ({
    ...tracker.getSnapshot(),
    entries: [],
  }));

  const snapshot = useSyncExternalStore(
    isVisible ? tracker.subscribe : noopSubscribe,
    isVisible ? tracker.getSnapshot : () => hiddenInitialSnapshot,
  );

  const { connectionState, hello, telemetry, entries } = snapshot;

  const [line, setLine] = useState('');
  const [autoscroll, setAutoscroll] = useState(true);
  const [error, setError] = useState('');
  const logViewRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    if (autoscroll && isVisible && logViewRef.current) {
      logViewRef.current.scrollTop = logViewRef.current.scrollHeight;
    }
  }, [autoscroll, entries, isVisible]);

  const tofText =
    telemetry?.tof_mm && telemetry.tof_mm.length > 0 ? `${telemetry.tof_mm.join(' / ')} mm` : '—';
  const batteryText =
    telemetry?.batt_mv !== undefined
      ? `${telemetry.batt_mv} mV (${(telemetry.batt_mv / 1000).toFixed(2)} V)`
      : '—';

  return (
    <section className="serial-monitor" aria-label="Network Console" data-testid="network-console">
      <div
        data-testid="network-telemetry-strip"
        aria-label="Telemetry strip"
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          gap: '12px',
          padding: '6px 10px',
          background: '#151e27',
          border: '1px solid #2b3947',
          borderRadius: 4,
          fontSize: 12,
        }}
      >
        <span data-testid="telemetry-connection">
          <strong>Link:</strong> {connectionState}
          {hello ? ` (${hello.name} v${hello.fw})` : ''}
        </span>
        <span data-testid="telemetry-mode">
          <strong>Mode:</strong>{' '}
          {telemetry ? `${telemetry.mode}${telemetry.estop ? ' (ESTOP)' : ''}` : '—'}
        </span>
        <span data-testid="telemetry-throttle">
          <strong>Throttle:</strong> {telemetry ? telemetry.throttle.toFixed(2) : '—'}
        </span>
        <span data-testid="telemetry-steer">
          <strong>Steer:</strong> {telemetry ? telemetry.steer.toFixed(2) : '—'}
        </span>
        <span data-testid="telemetry-tof">
          <strong>ToF:</strong> {tofText}
        </span>
        <span data-testid="telemetry-battery">
          <strong>Battery:</strong> {batteryText}
        </span>

        <div className="panel-tools" style={{ marginLeft: 'auto' }}>
          {connectionState === 'connected' ? (
            <button
              type="button"
              onClick={() => {
                void api.control.disconnect().catch((err) => setError(parseIpcError(err).message));
              }}
            >
              Disconnect
            </button>
          ) : (
            <button
              type="button"
              onClick={() => {
                setError('');
                void api.control
                  .connect({ kind: 'run' })
                  .catch((err) => setError(parseIpcError(err).message));
              }}
            >
              Connect
            </button>
          )}
          <label>
            <input
              type="checkbox"
              checked={autoscroll}
              onChange={(event) => setAutoscroll(event.target.checked)}
            />{' '}
            Autoscroll
          </label>
          <button
            type="button"
            onClick={() => {
              tracker.clearEntries();
            }}
          >
            Clear
          </button>
        </div>
      </div>

      <PhoneControl api={api} />

      <pre ref={logViewRef} aria-label="Network Console messages" data-testid="network-console-log">
        {entries.length > 0
          ? entries
              .map((entry) =>
                entry.direction === 'in' ? `← ${entry.formatted}` : `→ ${entry.raw}`,
              )
              .join('\n')
          : 'Control protocol JSON lines will appear here.'}
      </pre>

      {error ? (
        <p className="notice" role="alert">
          {error}
        </p>
      ) : null}

      <form
        onSubmit={(event) => {
          event.preventDefault();
          const trimmed = line.trim();
          if (!trimmed) return;
          void api.control
            .sendRaw(trimmed)
            .then(() => {
              setLine('');
              setError('');
            })
            .catch((err) => setError(parseIpcError(err).message));
        }}
      >
        <input
          aria-label="Network Console send line"
          value={line}
          placeholder='Send JSON line, e.g. {"t":"mode","mode":"auto"}'
          onChange={(event) => setLine(event.target.value)}
        />
        <button type="submit">Send</button>
      </form>
    </section>
  );
}
