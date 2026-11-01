import { defineConfig } from 'vitest/config';

// One Vitest run over every TS package; each package keeps its own config.
export default defineConfig({
  test: {
    projects: ['packages/*/vitest.config.ts', 'apps/*/vitest.config.mts'],
  },
});
