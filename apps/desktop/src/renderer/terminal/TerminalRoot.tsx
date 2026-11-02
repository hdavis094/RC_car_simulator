import { lazy, Suspense, useEffect, useState } from 'react';
import type { FileEntry, RcsimApi } from '../../shared/ipc.ts';
import { parseIpcError } from '../../shared/ipc.ts';
import { useEditorStore } from './editor-state.ts';

const Editor = lazy(() => import('./Editor.tsx').then((module) => ({ default: module.Editor })));

function FileTree({
  entries,
  parent = '',
  open,
}: {
  entries: readonly FileEntry[];
  parent?: string;
  open: (path: string) => void;
}) {
  return (
    <ul className="file-tree">
      {entries
        .filter((entry) => entry.path.slice(0, entry.path.lastIndexOf('/') + 1) === parent)
        .map((entry) => {
          const name = entry.path.split('/').at(-1);
          return (
            <li key={entry.path}>
              {entry.kind === 'dir' ? (
                <details open>
                  <summary>{name}</summary>
                  <FileTree entries={entries} parent={`${entry.path}/`} open={open} />
                </details>
              ) : (
                <button type="button" title={entry.path} onClick={() => open(entry.path)}>
                  {name}
                </button>
              )}
            </li>
          );
        })}
    </ul>
  );
}

export function TerminalRoot({
  api = window.rcsim,
  projectDir,
}: {
  api?: RcsimApi;
  projectDir?: string;
}) {
  const [files, setFiles] = useState<readonly FileEntry[]>([]);
  const [error, setError] = useState('');
  const documents = useEditorStore((state) => state.documents);
  const active = useEditorStore((state) => state.active);
  const report = (error: unknown): void => setError(parseIpcError(error).message);

  useEffect(() => {
    if (!projectDir) return;
    let alive = true;
    const refresh = (): void => {
      void api.project
        .listFiles()
        .then((entries) => {
          if (alive) setFiles(entries);
        })
        .catch((error) => {
          if (alive) setError(parseIpcError(error).message);
        });
    };
    refresh();
    const off = api.project.onFileChange((change) => {
      refresh();
      if (change.kind !== 'remove')
        void useEditorStore
          .getState()
          .reload(api, change.path)
          .catch(() => {});
      else if (useEditorStore.getState().documents.some((doc) => doc.path === change.path)) {
        setError(`${change.path} was removed on disk. Save to recreate it, or close the tab.`);
      }
    });
    return () => {
      alive = false;
      off();
    };
  }, [api, projectDir]);

  const close = (path: string): void => {
    const doc = documents.find((doc) => doc.path === path);
    if (doc && doc.text !== doc.saved && !window.confirm(`Discard unsaved changes to ${path}?`))
      return;
    useEditorStore.getState().close(path);
  };
  return (
    <section className="terminal-environment" aria-label="Terminal environment">
      <aside className="explorer">
        <div className="section-label">
          <h1>Terminal</h1>
          <span>FILES</span>
        </div>
        {projectDir ? (
          <FileTree
            entries={files}
            open={(path) => {
              void useEditorStore.getState().open(api, path).catch(report);
            }}
          />
        ) : (
          <p className="muted">Open a car project to edit firmware.</p>
        )}
      </aside>
      <div className="editor-area">
        <div className="editor-tabs" role="tablist" aria-label="Open files">
          {documents.map((doc) => (
            <div className="editor-tab" key={doc.path}>
              <button
                type="button"
                role="tab"
                aria-selected={active === doc.path}
                title={doc.path}
                onClick={() => useEditorStore.setState({ active: doc.path })}
              >
                {doc.path.split('/').at(-1)}
                {doc.text !== doc.saved ? ' ●' : ''}
              </button>
              <button
                type="button"
                aria-label={`Close ${doc.path}`}
                onClick={() => close(doc.path)}
              >
                ×
              </button>
            </div>
          ))}
        </div>
        {error ? (
          <div className="notice" role="alert">
            {error}
            <button type="button" onClick={() => setError('')} aria-label="Dismiss editor error">
              ×
            </button>
          </div>
        ) : null}
        {documents.find((doc) => doc.path === active)?.conflict ? (
          <div className="notice" role="alert">
            This file changed on disk. Your edits are preserved.
            <button
              type="button"
              onClick={() => {
                if (!active || !window.confirm('Discard your edits and reload the disk version?'))
                  return;
                void api.project
                  .readFile(active)
                  .then((text) =>
                    useEditorStore.setState((state) => ({
                      documents: state.documents.map((doc) =>
                        doc.path === active ? { ...doc, text, saved: text, conflict: false } : doc,
                      ),
                    })),
                  )
                  .catch(report);
              }}
            >
              Reload from disk
            </button>
          </div>
        ) : null}
        {active ? (
          <Suspense fallback={<p className="empty-state">Loading editor…</p>}>
            <Editor />
          </Suspense>
        ) : (
          <div className="empty-state">
            <p className="eyebrow">FIRMWARE</p>
            <h2>Make the car move.</h2>
            <p>Choose a file in the project to start editing.</p>
          </div>
        )}
      </div>
    </section>
  );
}
