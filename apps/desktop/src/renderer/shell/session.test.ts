import { beforeEach, describe, expect, it } from 'vitest';
import { useSessionStore } from './session.ts';

const diagnostic = {
  file: 'src/main.cpp',
  line: 2,
  column: 3,
  severity: 'error' as const,
  message: 'typo',
};
describe('build session state', () => {
  beforeEach(() => useSessionStore.setState(useSessionStore.getInitialState()));
  it('replaces a previous build output and diagnostics when a new build emits output', () => {
    const session = useSessionStore.getState();
    session.buildEvent({ kind: 'output', buildId: 'old', stream: 'stderr', text: 'old output' });
    session.buildEvent({
      kind: 'done',
      buildId: 'old',
      ok: false,
      exitCode: 1,
      durationMs: 1,
      diagnostics: [diagnostic],
    });
    session.buildEvent({ kind: 'output', buildId: 'new', stream: 'stdout', text: 'new output' });
    session.buildEvent({ kind: 'output', buildId: 'new', stream: 'stderr', text: ' more' });
    expect(useSessionStore.getState()).toMatchObject({
      output: 'new output more',
      diagnostics: [],
      buildStatus: 'building',
      buildId: 'new',
    });
  });
  it('clears output when a new build completes without producing any output', () => {
    const session = useSessionStore.getState();
    session.buildEvent({ kind: 'output', buildId: 'old', stream: 'stderr', text: 'old error' });
    session.buildEvent({
      kind: 'done',
      buildId: 'new',
      ok: true,
      exitCode: 0,
      durationMs: 1,
      diagnostics: [],
    });
    expect(useSessionStore.getState()).toMatchObject({
      output: '',
      diagnostics: [],
      buildStatus: 'succeeded',
    });
  });
  it('starts an editor build with a fresh output panel and resets project resources', () => {
    const session = useSessionStore.getState();
    session.buildEvent({ kind: 'output', buildId: 'old', stream: 'stderr', text: 'old output' });
    session.addShell();
    session.startBuild();
    expect(useSessionStore.getState()).toMatchObject({
      buildId: null,
      buildStatus: 'building',
      output: '',
      diagnostics: [],
      panel: 'build',
      panelOpen: true,
    });
    session.reset();
    expect(useSessionStore.getState()).toMatchObject({
      buildStatus: 'idle',
      shells: [],
      buildId: null,
      output: '',
    });
  });
});
