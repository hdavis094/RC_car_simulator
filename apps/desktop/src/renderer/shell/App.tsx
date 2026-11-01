import type { ReactNode } from 'react';
import { TerminalRoot } from '../terminal/index.ts';
import { WorkbenchRoot } from '../workbench/index.ts';
import { WorldRoot } from '../world/index.ts';
import { ENVIRONMENTS, useEnvironmentStore, type Environment } from './environment-store.ts';

const LABELS: Record<Environment, string> = {
  workbench: 'Workbench',
  terminal: 'Terminal',
  world: '3D World',
};

function EnvironmentRoot({ environment }: { environment: Environment }): ReactNode {
  switch (environment) {
    case 'workbench':
      return <WorkbenchRoot />;
    case 'terminal':
      return <TerminalRoot />;
    case 'world':
      return <WorldRoot />;
  }
}

export function App(): ReactNode {
  const current = useEnvironmentStore((state) => state.current);
  const show = useEnvironmentStore((state) => state.show);

  return (
    <div
      style={{ display: 'flex', flexDirection: 'column', height: '100vh', fontFamily: 'system-ui' }}
    >
      <nav aria-label="Environments" style={{ display: 'flex', gap: 4, padding: 8 }}>
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
      <main style={{ flex: 1, padding: 8 }}>
        <EnvironmentRoot environment={current} />
      </main>
    </div>
  );
}
