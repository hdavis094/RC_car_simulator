import { create } from 'zustand';

/** The three environments of the app (GLOSSARY.md). */
export const ENVIRONMENTS = ['workbench', 'terminal', 'world'] as const;
export type Environment = (typeof ENVIRONMENTS)[number];

interface EnvironmentState {
  current: Environment;
  show: (environment: Environment) => void;
}

export const useEnvironmentStore = create<EnvironmentState>()((set) => ({
  current: 'workbench',
  show: (environment) => set({ current: environment }),
}));
