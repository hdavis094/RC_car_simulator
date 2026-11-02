import { create } from 'zustand';
import type { BuildEvent, Diagnostic, RunInfo } from '../../shared/ipc.ts';

interface SessionState {
  buildStatus: 'idle' | 'building' | 'succeeded' | 'failed';
  buildId: string | null;
  output: string;
  diagnostics: readonly Diagnostic[];
  run: RunInfo | null;
  panel: 'build' | 'serial' | string;
  panelOpen: boolean;
  shells: readonly number[];
  nextShell: number;
  showPanel: (panel: string) => void;
  addShell: () => void;
  closeShell: (id: number) => void;
  startBuild: () => void;
  buildEvent: (event: BuildEvent) => void;
  reset: () => void;
}
export const useSessionStore = create<SessionState>((set) => ({
  buildStatus: 'idle',
  buildId: null,
  output: '',
  diagnostics: [],
  run: null,
  panel: 'build',
  panelOpen: true,
  shells: [],
  nextShell: 1,
  showPanel: (panel) => set({ panel, panelOpen: true }),
  addShell: () =>
    set((state) => ({
      shells: [...state.shells, state.nextShell],
      panel: `shell-${state.nextShell}`,
      panelOpen: true,
      nextShell: state.nextShell + 1,
    })),
  closeShell: (id) =>
    set((state) => ({
      shells: state.shells.filter((shell) => shell !== id),
      ...(state.panel === `shell-${id}` ? { panel: 'build' } : {}),
    })),
  startBuild: () =>
    set({
      buildStatus: 'building',
      buildId: null,
      output: '',
      diagnostics: [],
      panel: 'build',
      panelOpen: true,
    }),
  buildEvent: (event) =>
    set((state) =>
      event.kind === 'output'
        ? {
            output: (
              (state.buildId === event.buildId || state.buildId === null ? state.output : '') +
              event.text
            ).slice(-1_000_000),
            diagnostics: state.buildId === event.buildId ? state.diagnostics : [],
            buildId: event.buildId,
            buildStatus: 'building',
          }
        : {
            buildStatus: event.ok ? 'succeeded' : 'failed',
            buildId: event.buildId,
            diagnostics: event.diagnostics,
          },
    ),
  reset: () =>
    set({
      buildStatus: 'idle',
      buildId: null,
      output: '',
      diagnostics: [],
      run: null,
      shells: [],
      panel: 'build',
    }),
}));
