import type { PhysicsStage } from '@rcsim/sim-core/api';
import { create } from 'zustand';
import { RUN_SPEEDS, type RunSpeed } from '../../shared/ipc.ts';

export interface Preferences {
  readonly dockPosition: 'bottom' | 'right';
  readonly dockSize: number;
  readonly simulationSpeed: RunSpeed;
  readonly physicsStage: PhysicsStage;
}

const KEY = 'rcsim.preferences.v1';
const DEFAULTS: Preferences = {
  dockPosition: 'bottom',
  dockSize: 280,
  simulationSpeed: 1,
  physicsStage: 1,
};

function persisted(input: unknown): Preferences {
  if (!input || typeof input !== 'object') return DEFAULTS;
  const entry = input as Partial<Preferences>;
  return {
    dockPosition: entry.dockPosition === 'right' ? 'right' : 'bottom',
    dockSize:
      typeof entry.dockSize === 'number' && Number.isInteger(entry.dockSize)
        ? Math.max(160, Math.min(520, entry.dockSize))
        : DEFAULTS.dockSize,
    simulationSpeed: RUN_SPEEDS.find((speed) => speed === entry.simulationSpeed) ?? 1,
    physicsStage: entry.physicsStage === 2 ? 2 : 1,
  };
}

export function readPreferences(storage?: Pick<Storage, 'getItem'>): Preferences {
  try {
    const raw = (storage ?? window.localStorage).getItem(KEY);
    return raw ? persisted(JSON.parse(raw)) : DEFAULTS;
  } catch {
    return DEFAULTS;
  }
}

export function writePreferences(
  preferences: Preferences,
  storage?: Pick<Storage, 'setItem'>,
): void {
  try {
    (storage ?? window.localStorage).setItem(KEY, JSON.stringify(preferences));
  } catch {
    // Preferences are still available for this session if storage is unavailable.
  }
}

interface PreferencesStore extends Preferences {
  update(patch: Partial<Preferences>): void;
}

export const usePreferencesStore = create<PreferencesStore>((set) => ({
  ...readPreferences(),
  update(patch) {
    set((state) => {
      const next = persisted({ ...state, ...patch });
      writePreferences(next);
      return next;
    });
  },
}));
