import type { ReactNode } from 'react';
import { RUN_SPEEDS } from '../../shared/ipc.ts';
import { usePreferencesStore } from './preferences.ts';

export function PreferencesPanel(): ReactNode {
  const dock = usePreferencesStore((state) => state.dockPosition);
  const speed = usePreferencesStore((state) => state.simulationSpeed);
  const physicsStage = usePreferencesStore((state) => state.physicsStage);
  const update = usePreferencesStore((state) => state.update);

  return (
    <section className="preferences-panel" id="app-settings" aria-label="Settings">
      <label>
        Panel position
        <select
          value={dock}
          onChange={(event) =>
            update({ dockPosition: event.target.value === 'right' ? 'right' : 'bottom' })
          }
        >
          <option value="bottom">Bottom</option>
          <option value="right">Right</option>
        </select>
      </label>
      <label>
        Initial simulation speed
        <select
          value={String(speed)}
          onChange={(event) => {
            const selected = RUN_SPEEDS.find((value) => String(value) === event.target.value);
            if (selected !== undefined) update({ simulationSpeed: selected });
          }}
        >
          {RUN_SPEEDS.map((value) => (
            <option key={value} value={value}>
              {value === 'unpaced' ? 'Unpaced' : `${value}×`}
            </option>
          ))}
        </select>
      </label>
      <label>
        Physics model
        <select
          value={physicsStage}
          onChange={(event) => update({ physicsStage: event.target.value === '2' ? 2 : 1 })}
        >
          <option value="1">Stage 1</option>
          <option value="2">Stage 2 · Tyre grip and battery sag</option>
        </select>
      </label>
    </section>
  );
}
