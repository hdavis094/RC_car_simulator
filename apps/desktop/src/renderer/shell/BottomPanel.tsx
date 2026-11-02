import { useState, type ReactNode } from 'react';
import type { Diagnostic, RcsimApi } from '../../shared/ipc.ts';
import { BuildOutput } from '../terminal/BuildOutput.tsx';
import { SerialMonitor } from '../terminal/SerialMonitor.tsx';
import { ShellPanel } from '../terminal/ShellPanel.tsx';
import { useSessionStore } from './session.ts';

/** App owns one dock across environments. Extra tabs let 3D World add a Network Console. */
export interface DockTab {
  readonly id: string;
  readonly label: string;
  readonly content: ReactNode;
}
export function BottomPanel({
  api = window.rcsim,
  projectDir,
  jump,
  tabs = [],
}: {
  api?: RcsimApi;
  projectDir: string;
  jump: (diagnostic: Diagnostic) => void;
  tabs?: readonly DockTab[];
}) {
  const panel = useSessionStore((state) => state.panel);
  const open = useSessionStore((state) => state.panelOpen);
  const shells = useSessionStore((state) => state.shells);
  const show = useSessionStore((state) => state.showPanel);
  const [dock, setDock] = useState<'bottom' | 'right'>('bottom');
  const [size, setSize] = useState(280);
  return (
    <section
      className={`bottom-panel dock-${dock}`}
      style={{ flexBasis: open ? size : 40 }}
      aria-label="Shared bottom panel"
    >
      <div className="dock-toolbar">
        <div role="tablist" aria-label="Panel tabs">
          {[
            { id: 'build', label: 'Build output' },
            { id: 'serial', label: 'Serial Monitor' },
            ...shells.map((id) => ({ id: `shell-${id}`, label: `Shell ${id}` })),
            ...tabs,
          ].map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={open && panel === tab.id}
              onClick={() => show(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </div>
        <button type="button" onClick={() => useSessionStore.getState().addShell()}>
          + Shell
        </button>
        {panel.startsWith('shell-') ? (
          <button
            type="button"
            aria-label="Close shell"
            onClick={() => useSessionStore.getState().closeShell(Number(panel.slice(6)))}
          >
            ×
          </button>
        ) : null}
        <label className="dock-size">
          Size{' '}
          <input
            type="range"
            aria-label="Panel size"
            min="160"
            max="520"
            value={size}
            onChange={(event) => setSize(Number(event.target.value))}
          />
        </label>
        <button type="button" onClick={() => setDock(dock === 'bottom' ? 'right' : 'bottom')}>
          {dock === 'bottom' ? 'Dock right' : 'Dock bottom'}
        </button>
        <button
          type="button"
          aria-label={open ? 'Collapse panel' : 'Expand panel'}
          onClick={() => useSessionStore.setState({ panelOpen: !open })}
        >
          {open ? '⌄' : '⌃'}
        </button>
      </div>
      <div className="dock-content" hidden={!open}>
        <div hidden={panel !== 'build'} className="panel-page">
          <BuildOutput jump={jump} />
        </div>
        <div hidden={panel !== 'serial'} className="panel-page">
          <SerialMonitor api={api} visible={open && panel === 'serial'} />
        </div>
        {shells.map((id) => (
          <div hidden={panel !== `shell-${id}`} className="panel-page" key={id}>
            <ShellPanel api={api} cwd={projectDir} visible={open && panel === `shell-${id}`} />
          </div>
        ))}
        {tabs.map((tab) => (
          <div hidden={panel !== tab.id} className="panel-page" key={tab.id}>
            {tab.content}
          </div>
        ))}
      </div>
    </section>
  );
}
