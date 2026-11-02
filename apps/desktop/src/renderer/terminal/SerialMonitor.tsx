import { useEffect, useRef, useState } from 'react';
import type { RcsimApi } from '../../shared/ipc.ts';
import { parseIpcError } from '../../shared/ipc.ts';

/** Shared with 3D World through BottomPanel. Subscriptions survive tab changes. */
export function SerialMonitor({
  api = window.rcsim,
  visible = true,
}: {
  api?: RcsimApi;
  visible?: boolean;
}) {
  const [output, setOutput] = useState('');
  const [line, setLine] = useState('');
  const [autoscroll, setAutoscroll] = useState(true);
  const [error, setError] = useState('');
  const view = useRef<HTMLPreElement>(null);
  useEffect(
    () => api.run.onSerial((text) => setOutput((previous) => (previous + text).slice(-500_000))),
    [api],
  );
  useEffect(() => {
    if (autoscroll && view.current) view.current.scrollTop = view.current.scrollHeight;
  }, [autoscroll, output, visible]);
  return (
    <section className="serial-monitor" aria-label="Serial Monitor">
      <div className="panel-tools">
        <label>
          <input
            type="checkbox"
            checked={autoscroll}
            onChange={(event) => setAutoscroll(event.target.checked)}
          />{' '}
          Autoscroll
        </label>
        <button type="button" onClick={() => setOutput('')}>
          Clear
        </button>
      </div>
      <pre ref={view} aria-label="Serial output">
        {output || 'Serial output will appear when a run starts.'}
      </pre>
      {error ? (
        <p className="notice" role="alert">
          {error}
        </p>
      ) : null}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void api.run
            .sendSerial(`${line}\n`)
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
        <button type="submit">Send</button>
      </form>
    </section>
  );
}
