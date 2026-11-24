import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';

// Workspace packages export TypeScript source, so main and preload must bundle
// them instead of leaving them as runtime requires.
const workspacePackages = [
  '@rcsim/control-protocol',
  '@rcsim/schema',
  '@rcsim/sim-core',
  '@rcsim/sim-protocol',
];

export default defineConfig({
  main: {
    build: {
      externalizeDeps: { exclude: workspacePackages },
      rolldownOptions: {
        input: {
          index: fileURLToPath(new URL('./src/main/index.ts', import.meta.url)),
          'sim-host': fileURLToPath(
            new URL('./src/main/services/sim/host-entry.ts', import.meta.url),
          ),
        },
      },
    },
  },
  preload: {
    build: { externalizeDeps: { exclude: workspacePackages } },
  },
  renderer: {
    plugins: [react()],
  },
});
