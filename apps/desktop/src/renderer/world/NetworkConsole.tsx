import {
  parseCarLine,
  type ConnectionState,
  type Hello,
  type Telemetry,
} from '@rcsim/control-protocol/messages';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { parseIpcError, type RcsimApi } from '../../shared/ipc.ts';

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

export function NetworkConsole({
  api = window.rcsim,
  visible = true,
}: {
  readonly api?: RcsimApi;
  readonly visible?: boolean;
}): ReactNode {
  const [connectionState, setConnectionState] = useState<ConnectionState>('idle');
  const [hello, setHello] = useState<Hello | null>(null);
  const [telemetry, setTelemetry] = useState<Telemetry | null>(null);
  const [entries, setEntries] = useState<readonly RawConsoleEntry[]>([]);
  const [line, setLine] = useState('');
  const [autoscroll, setAutoscroll] = useState(true);
  const [error, setError] = useState('');
  const nextIdRef = useRef(1);
  const logViewRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    const offState = api.control.onState((state) => {
      setConnectionState(state);
    });
    const offMsg = api.control.onMessage((msg) => {
      if (msg.t === 'telemetry') {
        setTelemetry(msg);
      } else if (msg.t === 'hello') {
        setHello(msg);
      }
    });
    const offRaw = api.control.onRaw((rawLine, direction) => {
      if (direction === 'in') {
        const parsed = parseCarLine(rawLine.trim());
        if (parsed.ok) {
          if (parsed.message.t === 'telemetry') setTelemetry(parsed.message);
          else if (parsed.message.t === 'hello') setHello(parsed.message);
        }
      }
      const entry: RawConsoleEntry = {
        id: nextIdRef.current++,
        direction,
        raw: rawLine.trim(),
        formatted: direction === 'in' ? formatIncomingLine(rawLine) : rawLine.trim(),
      };
      setEntries((prev) => [...prev.slice(-499), entry]);
    });
    return () => {
      offState();
      offMsg();
      offRaw();
    };
  }, [api]);

  useEffect(() => {
    if (autoscroll && logViewRef.current) {
      logViewRef.current.scrollTop = logViewRef.current.scrollHeight;
    }
  }, [autoscroll, entries, visible]);

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
          <button type="button" onClick={() => setEntries([])}>
            Clear
          </button>
        </div>
      </div>

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
