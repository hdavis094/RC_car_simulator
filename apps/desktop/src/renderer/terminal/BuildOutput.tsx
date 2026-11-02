import { useEffect, useRef } from 'react';
import type { Diagnostic } from '../../shared/ipc.ts';
import { useSessionStore } from '../shell/session.ts';

export function BuildOutput({ jump }: { jump: (diagnostic: Diagnostic) => void }) {
  const output = useSessionStore((state) => state.output);
  const diagnostics = useSessionStore((state) => state.diagnostics);
  const status = useSessionStore((state) => state.buildStatus);
  const view = useRef<HTMLPreElement>(null);
  useEffect(() => {
    if (view.current) view.current.scrollTop = view.current.scrollHeight;
  }, [output]);
  return (
    <section className="build-output" aria-label="Build output">
      <pre ref={view} aria-label="Compiler output">
        {output || 'Build for Sim compiles the firmware with your system C++ compiler.'}
      </pre>
      {diagnostics.length ? (
        <ul aria-label="Compiler diagnostics">
          {diagnostics.map((diagnostic, index) => (
            <li key={index}>
              <button
                type="button"
                className={`diagnostic ${diagnostic.severity}`}
                disabled={!diagnostic.file}
                onClick={() => jump(diagnostic)}
              >
                <span>
                  {diagnostic.file
                    ? `${diagnostic.file}:${diagnostic.line}:${diagnostic.column}`
                    : 'Linker'}
                </span>{' '}
                {diagnostic.severity}: {diagnostic.message}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="build-result" role="status">
        {status === 'idle'
          ? 'Ready to build'
          : status === 'building'
            ? 'Building…'
            : status === 'succeeded'
              ? 'Build succeeded'
              : 'Build failed'}
      </div>
    </section>
  );
}
