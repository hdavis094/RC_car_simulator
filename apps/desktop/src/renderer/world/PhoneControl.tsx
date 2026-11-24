import { useEffect, useState, type ReactNode } from 'react';
import { DEFAULT_PORT } from '@rcsim/control-protocol/messages';
import { parseIpcError, type PhoneControlSession, type RcsimApi } from '../../shared/ipc.ts';

export function PhoneControl({ api }: { api: RcsimApi }): ReactNode {
  const [session, setSession] = useState<PhoneControlSession | null>(null);
  const [host, setHost] = useState('');
  const [port, setPort] = useState(String(DEFAULT_PORT));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let current = true;
    let received = false;
    const unsubscribe = api.phoneControl.onStatus((info) => {
      received = true;
      setSession(info);
    });
    void api.phoneControl.status().then(
      (info) => {
        if (current && !received) setSession(info);
      },
      (cause: unknown) => {
        if (current && !received) setError(parseIpcError(cause).message);
      },
    );
    return () => {
      current = false;
      unsubscribe();
    };
  }, [api.phoneControl]);

  const toggle = async (): Promise<void> => {
    setBusy(true);
    setError('');
    try {
      if (session) await api.phoneControl.stop();
      else setSession(await api.phoneControl.start());
    } catch (cause) {
      setError(parseIpcError(cause).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <details>
      <summary>Phone control</summary>
      <p>Share controls with one phone on your local network.</p>
      <button type="button" disabled={busy} onClick={() => void toggle()}>
        {session ? 'Disable phone control' : 'Enable phone control'}
      </button>
      {session ? (
        <ul aria-label="Phone control links">
          {session.urls.map((url) => (
            <li key={url}>
              <input aria-label={`Phone link for ${new URL(url).hostname}`} value={url} readOnly />
              <button
                type="button"
                onClick={() => {
                  void navigator.clipboard
                    .writeText(url)
                    .catch(() => setError('Select the link and copy it.'));
                }}
              >
                Copy link
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          setError('');
          void api.control
            .connect({ kind: 'host', host, port: Number(port) })
            .catch((cause) => setError(parseIpcError(cause).message));
        }}
      >
        <label>
          Car host
          <input value={host} onChange={(event) => setHost(event.target.value)} required />
        </label>
        <label>
          Port
          <input
            value={port}
            onChange={(event) => setPort(event.target.value)}
            type="number"
            min={1}
            max={65535}
            required
          />
        </label>
        <button type="submit">Connect to real car</button>
        <button
          type="button"
          onClick={() => {
            setError('');
            void api.control
              .connect({ kind: 'run' })
              .catch((cause) => setError(parseIpcError(cause).message));
          }}
        >
          Use simulation
        </button>
      </form>
      {error && <p role="alert">{error}</p>}
    </details>
  );
}
