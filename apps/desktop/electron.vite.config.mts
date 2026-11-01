import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';

// Workspace packages export TypeScript source, so main and preload must bundle
// them instead of leaving them as runtime requires.
const workspacePackages = ['@rcsim/control-protocol', '@rcsim/schema', '@rcsim/sim-core'];

export default defineConfig({
  main: {
    build: { externalizeDeps: { exclude: workspacePackages } },
  },
  preload: {
    build: { externalizeDeps: { exclude: workspacePackages } },
  },
  renderer: {
    plugins: [react()],
  },
});
