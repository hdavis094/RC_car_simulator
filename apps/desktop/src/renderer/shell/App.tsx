import { DEFAULT_PORT } from '@rcsim/control-protocol/messages';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Diagnostic, ProjectInfo, RcsimApi } from '../../shared/ipc.ts';
import { parseIpcError } from '../../shared/ipc.ts';
import { TerminalRoot } from '../terminal/index.ts';
import { PlatformioActions } from '../terminal/PlatformioActions.tsx';
import { useEditorStore } from '../terminal/editor-state.ts';
import { WorkbenchRoot } from '../workbench/index.ts';
import { useWorkbenchStore } from '../workbench/workbench-store.ts';
import { WorldRoot, createWorldDockTabs } from '../world/index.ts';
import { BottomPanel } from './BottomPanel.tsx';
import { ENVIRONMENTS, useEnvironmentStore, type Environment } from './environment-store.ts';
import { useSessionStore } from './session.ts';
import { hasUnsavedChanges } from './unsaved.ts';
import './shell.css';

const LABELS: Record<Environment, string> = {
  workbench: 'Workbench',
  terminal: 'Terminal',
  world: '3D World',
};

export function App({ api = window.rcsim }: { api?: RcsimApi }): ReactNode {
  const current = useEnvironmentStore((state) => state.current);
  const show = useEnvironmentStore((state) => state.show);
  const [project, setProject] = useState<ProjectInfo | null>(null);
  const [recent, setRecent] = useState<readonly ProjectInfo[]>([]);
  const [newProject, setNewProject] = useState(false);
  const [path, setPath] = useState('');
  const [error, setError] = useState('');
  const [working, setWorking] = useState(false);
  const buildStatus = useSessionStore((state) => state.buildStatus);
  const buildId = useSessionStore((state) => state.buildId);
  const run = useSessionStore((state) => state.run);
  const controlPort = run?.netMappings.find(
    (mapping) => mapping.proto === 'tcp' && mapping.firmwarePort === DEFAULT_PORT,
  )?.hostPort;
  const documents = useEditorStore((state) => state.documents);
  const active = useEditorStore((state) => state.active);
  const report = (error: unknown): void => setError(parseIpcError(error).message);
  // World's dock tabs (the Network Console) stay mounted across environments while a project is
  // open, so the console keeps its history like the Serial Monitor does.
  const worldDockTabs = useMemo(() => createWorldDockTabs(api), [api]);

  useEffect(() => {
    let alive = true;
    void Promise.all([api.project.current(), api.project.recent()])
      .then(([project, recent]) => {
        if (alive) {
          setProject(project);
          setRecent(recent);
        }
      })
      .catch((error) => {
        if (alive) setError(parseIpcError(error).message);
      });
    const offBuild = api.build.onEvent((event) => useSessionStore.getState().buildEvent(event));
    const offRun = api.run.onStatus((run) => useSessionStore.setState({ run }));
    return () => {
      alive = false;
      offBuild();
      offRun();
    };
  }, [api]);
  useEffect(() => {
    const guard = (event: BeforeUnloadEvent): void => {
      if (hasUnsavedChanges()) event.preventDefault();
    };
    window.addEventListener('beforeunload', guard);
    return () => window.removeEventListener('beforeunload', guard);
  }, []);

  const openProject = async (dir?: string, create = false): Promise<void> => {
    if (working || buildStatus === 'building') return;
    if (hasUnsavedChanges() && !window.confirm('Discard unsaved changes and switch car project?'))
      return;
    setWorking(true);
    setError('');
    try {
      const next = create && dir ? await api.project.create(dir) : await api.project.open(dir);
      if (next) {
        if (run && run.state !== 'ended') await api.run.stop().catch(report);
        useEditorStore.getState().reset();
        useSessionStore.getState().reset();
        setProject(next);
        setNewProject(false);
        setRecent(await api.project.recent());
        show('terminal');
      }
    } catch (error) {
      report(error);
    } finally {
      setWorking(false);
    }
  };
  const saveProjectEdits = async (): Promise<void> => {
    await useEditorStore.getState().saveAll(api);
    const workbench = useWorkbenchStore.getState();
    if (workbench.dirty && !(await workbench.saveCar())) {
      throw new Error('Save the car project in the Workbench before continuing.');
    }
    if (hasUnsavedChanges()) throw new Error('Some edits changed while saving. Try again.');
  };
  const build = async (start: () => Promise<{ readonly buildId: string }>): Promise<void> => {
    if (!project || working || useSessionStore.getState().buildStatus === 'building') return;
    setError('');
    useSessionStore.getState().startBuild();
    try {
      await saveProjectEdits();
      const { buildId } = await start();
      useSessionStore.setState({ buildId });
    } catch (error) {
      report(error);
      useSessionStore.setState({ buildStatus: 'failed' });
    }
  };
  const jump = (diagnostic: Diagnostic): void => {
    show('terminal');
    void useEditorStore.getState().open(api, diagnostic.file, diagnostic).catch(report);
  };
  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            D
          </span>
          <div>
            DONKEY CAR<span>DESIGN / BUILD / DRIVE</span>
          </div>
        </div>
        <div className="project-title">
          <span className="project-dot" />
          {project?.name ?? 'No car project'}
          <small title={project?.dir}>{project?.dir ?? 'Start with a car project'}</small>
        </div>
        <div className="project-actions">
          <button
            type="button"
            data-action="open-project"
            disabled={working || buildStatus === 'building'}
            onClick={() => {
              void openProject();
            }}
          >
            Open project
          </button>
          <button
            type="button"
            data-action="new-project"
            disabled={working || buildStatus === 'building'}
            onClick={() => setNewProject(true)}
          >
            New project
          </button>
          <label className="recent-label">
            <span className="sr-only">Recent projects</span>
            <select
              aria-label="Recent projects"
              value=""
              disabled={working || buildStatus === 'building'}
              onChange={(event) => {
                if (event.target.value) void openProject(event.target.value);
              }}
            >
              <option value="">Recent projects</option>
              {recent.map((entry) => (
                <option value={entry.dir} key={entry.dir}>
                  {entry.name} — {entry.dir}
                </option>
              ))}
            </select>
          </label>
        </div>
      </header>
      <div className="environment-toolbar">
        <nav aria-label="Environments">
          {ENVIRONMENTS.map((environment) => (
            <button
              key={environment}
              type="button"
              aria-pressed={environment === current}
              onClick={() => show(environment)}
            >
              {LABELS[environment]}
            </button>
          ))}
        </nav>
        <div className="build-actions">
          <button
            type="button"
            data-action="save-file"
            disabled={!active || working}
            onClick={() => {
              if (active) void useEditorStore.getState().save(api, active).catch(report);
            }}
          >
            Save{documents.some((doc) => doc.text !== doc.saved) ? ' ●' : ''}
          </button>
          {buildStatus === 'building' && buildId ? (
            <button
              type="button"
              onClick={() => {
                void api.build.cancel(buildId).catch(report);
              }}
            >
              Cancel build
            </button>
          ) : null}
          {project && current === 'terminal' ? (
            <PlatformioActions
              hardware={api.hardware}
              disabled={working || buildStatus === 'building'}
              build={() => build(() => api.build.start('esp32'))}
              report={report}
            />
          ) : null}
          <button
            type="button"
            className="primary"
            data-action="build"
            disabled={!project || working || buildStatus === 'building'}
            onClick={() => {
              void build(() => api.build.start('sim'));
            }}
          >
            {buildStatus === 'building' ? 'Building…' : 'Build for Sim'}
          </button>
        </div>
      </div>
      {error ? (
        <div className="notice app-notice" role="alert">
          {error}
          <button type="button" aria-label="Dismiss error" onClick={() => setError('')}>
            ×
          </button>
        </div>
      ) : null}
      {newProject ? (
        <form
          className="new-project-form"
          aria-label="New car project"
          onSubmit={(event) => {
            event.preventDefault();
            void openProject(path, true);
          }}
        >
          <label>
            New car project folder
            <input
              autoFocus
              aria-label="New project folder"
              placeholder={
                api.platform === 'darwin' ? '/Users/you/Cars/my-car' : '/home/you/Cars/my-car'
              }
              value={path}
              onChange={(event) => setPath(event.target.value)}
              required
            />
          </label>
          <button className="primary" type="submit" disabled={working || !path.trim()}>
            Create project
          </button>
          <button type="button" onClick={() => setNewProject(false)}>
            Cancel
          </button>
        </form>
      ) : null}
      <div className="workspace" key={project?.dir ?? 'no-project'}>
        <main>
          <div className="environment-page" hidden={current !== 'workbench'}>
            <WorkbenchRoot api={api} />
          </div>
          <div className="environment-page" hidden={current !== 'terminal'}>
            <TerminalRoot api={api} {...(project ? { projectDir: project.dir } : {})} />
          </div>
          <div className="environment-page" hidden={current !== 'world'}>
            <WorldRoot api={api} prepareRun={saveProjectEdits} controlConnectsAutomatically />
          </div>
        </main>
        {project ? (
          <BottomPanel
            api={api}
            projectDir={project.dir}
            jump={jump}
            tabs={worldDockTabs}
            flash={(port) => build(() => api.hardware.flash(port))}
            flashDisabled={working || buildStatus === 'building'}
          />
        ) : null}
      </div>
      <footer className="status-bar">
        <span>
          <i className={`status-dot ${buildStatus}`} />
          Build: {buildStatus}
        </span>
        <span>Run: {run?.state ?? 'idle'}</span>
        {controlPort !== undefined ? <span>Control port {controlPort}</span> : null}
        <span className="status-end">
          {project ? 'Car project' : 'Open or create a car project to begin'}
          <span className="platform">{api.platform === 'darwin' ? 'macOS' : 'Linux'}</span>
        </span>
      </footer>
    </div>
  );
}
