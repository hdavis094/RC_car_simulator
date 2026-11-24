import { useCallback, useEffect, useRef, useState } from 'react';
import type { RcsimApi } from '../../shared/ipc.ts';
import { parseIpcError } from '../../shared/ipc.ts';
import './serial-monitor.css';

type Source = 'sim' | 'usb';

/** Shared with 3D World through BottomPanel. Subscriptions survive tab changes. */
export function SerialMonitor({
  api = window.rcsim,
  visible = true,
  flash,
  flashDisabled = false,
}: {
  api?: RcsimApi;
  visible?: boolean;
  flash?: (port: string) => Promise<void>;
  flashDisabled?: boolean;
}) {
  const [source, setSource] = useState<Source>('sim');
  const [history, setHistory] = useState({ sim: '', usb: '' });
  const [ports, setPorts] = useState<readonly string[]>([]);
  const [selectedPort, setSelectedPort] = useState('');
  const [connectedPort, setConnectedPort] = useState<string | null>(null);
  const [baud, setBaud] = useState('115200');
  const [changingPort, setChangingPort] = useState(false);
  const [line, setLine] = useState('');
  const [autoscroll, setAutoscroll] = useState(true);
  const [error, setError] = useState('');
  const view = useRef<HTMLPreElement>(null);
  const { hardware } = api;
  const output = history[source];
  const port = connectedPort ?? (ports.includes(selectedPort) ? selectedPort : '');
  const baudRate = Number(baud);
  const validBaud = Number.isSafeInteger(baudRate) && baudRate > 0 && baudRate <= 0x7fff_ffff;

  const refreshPorts = useCallback(
    () =>
      hardware.listSerialPorts().then(setPorts, (error: unknown) => {
        setError(parseIpcError(error).message);
      }),
    [hardware],
  );

  useEffect(() => {
    let observedPort = false;
    let alive = true;
    const append = (source: Source, text: string): void => {
      setHistory((previous) => ({
        ...previous,
        [source]: (previous[source] + text).slice(-500_000),
      }));
    };
    const offSim = api.run.onSerial((text) => append('sim', text));
    const offUsb = hardware.onSerialData((text) => append('usb', text));
    const offPort = hardware.onSerialPort((path) => {
      observedPort = true;
      setConnectedPort(path);
      if (!path) void refreshPorts();
    });
    void hardware
      .serialPort()
      .then((path) => {
        if (!alive || observedPort || !path) return;
        setConnectedPort(path);
        setSelectedPort(path);
        setSource('usb');
      })
      .catch((error: unknown) => {
        if (alive) setError(parseIpcError(error).message);
      });
    return () => {
      alive = false;
      offSim();
      offUsb();
      offPort();
    };
  }, [api, hardware, refreshPorts]);
  useEffect(() => {
    if (visible && source === 'usb') void refreshPorts();
  }, [visible, source, refreshPorts]);
  useEffect(() => {
    if (autoscroll && view.current) view.current.scrollTop = view.current.scrollHeight;
  }, [autoscroll, output, visible]);

  const changePort = async (action: () => Promise<void>): Promise<void> => {
    setChangingPort(true);
    setError('');
    try {
      await action();
    } catch (error) {
      setError(parseIpcError(error).message);
    } finally {
      setChangingPort(false);
    }
  };

  return (
    <section className="serial-monitor" aria-label="Serial Monitor">
      <div className="panel-tools">
        <label>
          Source{' '}
          <select
            value={source}
            disabled={changingPort}
            onChange={(event) => {
              const next = event.target.value === 'usb' ? 'usb' : 'sim';
              setError('');
              if (next === 'sim' && connectedPort) {
                void changePort(async () => {
                  await hardware.closeSerial();
                  setSource(next);
                });
              } else setSource(next);
            }}
          >
            <option value="sim">Simulator</option>
            <option value="usb">USB</option>
          </select>
        </label>
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
          onClick={() => setHistory((previous) => ({ ...previous, [source]: '' }))}
        >
          Clear
        </button>
      </div>
      {source === 'usb' ? (
        <div className="panel-tools serial-port-tools">
          <label>
            Port{' '}
            <select
              value={port}
              disabled={changingPort || !!connectedPort}
              onChange={(event) => setSelectedPort(event.target.value)}
            >
              <option value="">{ports.length ? 'Select a port' : 'No USB serial ports'}</option>
              {connectedPort && !ports.includes(connectedPort) ? (
                <option value={connectedPort}>{connectedPort}</option>
              ) : null}
              {ports.map((path) => (
                <option key={path} value={path}>
                  {path}
                </option>
              ))}
            </select>
          </label>
          <button type="button" onClick={() => void refreshPorts()}>
            Refresh ports
          </button>
          <label>
            Baud{' '}
            <input
              type="number"
              min="1"
              step="1"
              value={baud}
              disabled={changingPort || !!connectedPort}
              onChange={(event) => setBaud(event.target.value)}
            />
          </label>
          {connectedPort ? (
            <button
              type="button"
              disabled={changingPort}
              onClick={() => void changePort(() => hardware.closeSerial())}
            >
              Disconnect
            </button>
          ) : (
            <button
              type="button"
              disabled={changingPort || !port || !validBaud}
              onClick={() => void changePort(() => hardware.openSerial(port, baudRate))}
            >
              Connect
            </button>
          )}
          {flash ? (
            <button
              type="button"
              disabled={flashDisabled || changingPort || !port}
              onClick={() => void flash(port)}
            >
              Flash to ESP32
            </button>
          ) : null}
          <span role="status">{connectedPort ? 'Connected' : 'Disconnected'}</span>
        </div>
      ) : null}
      <pre ref={view} aria-label="Serial output">
        {output || (source === 'sim' ? 'Serial output will appear when a run starts.' : '')}
      </pre>
      {error ? (
        <p className="notice" role="alert">
          {error}
        </p>
      ) : null}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (source === 'usb' && (!connectedPort || changingPort)) return;
          const text = `${line}\n`;
          const send = source === 'sim' ? api.run.sendSerial(text) : hardware.writeSerial(text);
          void send
            .then(() => {
              setLine('');
              setError('');
            })
            .catch((error) => setError(parseIpcError(error).message));
        }}
      >
        <input
          aria-label="Serial send line"
          value={line}
          placeholder="Send a line to the firmware…"
          onChange={(event) => setLine(event.target.value)}
        />
        <button type="submit" disabled={source === 'usb' && (!connectedPort || changingPort)}>
          Send
        </button>
      </form>
    </section>
  );
}
