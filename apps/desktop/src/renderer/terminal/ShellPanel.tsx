import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import type { RcsimApi } from '../../shared/ipc.ts';
import { parseIpcError } from '../../shared/ipc.ts';

export function ShellPanel({
  api = window.rcsim,
  cwd,
  visible,
}: {
  api?: RcsimApi;
  cwd: string;
  visible: boolean;
}) {
  const host = useRef<HTMLDivElement>(null);
  const terminal = useRef<Terminal | null>(null);
  const fit = useRef<FitAddon | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!host.current) return;
    let disposed = false;
    let ptyId: string | undefined;
    const early: [string, string][] = [];
    const instance = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      scrollback: 5000,
      theme: { background: '#10171e', foreground: '#d1dce5' },
      allowProposedApi: false,
    });
    const addon = new FitAddon();
    instance.loadAddon(addon);
    instance.open(host.current);
    terminal.current = instance;
    fit.current = addon;
    const report = (error: unknown): void => {
      if (!disposed) setError(parseIpcError(error).message);
    };
    const offData = api.pty.onData((id, data) => {
      if (!ptyId) early.push([id, data]);
      else if (id === ptyId) instance.write(data);
    });
    const offExit = api.pty.onExit((id, code) => {
      if (id === ptyId) instance.writeln(`\r\n[Shell exited with code ${code}]`);
    });
    const input = instance.onData((data) => {
      if (ptyId) void api.pty.write(ptyId, data).catch(report);
    });
    const resize = (): void => {
      if (!host.current || host.current.clientWidth === 0 || host.current.clientHeight === 0)
        return;
      addon.fit();
      if (ptyId) void api.pty.resize(ptyId, instance.cols, instance.rows).catch(report);
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(host.current);
    void api.pty
      .spawn({ cwd, cols: instance.cols, rows: instance.rows })
      .then(({ ptyId: id }) => {
        if (disposed) {
          void api.pty.kill(id).catch(() => {});
          return;
        }
        ptyId = id;
        for (const [source, data] of early) if (source === id) instance.write(data);
        early.length = 0;
        resize();
      })
      .catch(report);
    return () => {
      disposed = true;
      offData();
      offExit();
      input.dispose();
      observer.disconnect();
      if (ptyId) void api.pty.kill(ptyId).catch(() => {});
      instance.dispose();
      terminal.current = null;
      fit.current = null;
    };
  }, [api, cwd]);
  useEffect(() => {
    if (!visible) return;
    const frame = requestAnimationFrame(() => {
      fit.current?.fit();
      terminal.current?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [visible]);
  return (
    <div className="shell-panel">
      {error ? (
        <p role="alert" className="notice">
          {error}
        </p>
      ) : null}
      <div className="xterm-host" ref={host} aria-label="Project shell" />
    </div>
  );
}
