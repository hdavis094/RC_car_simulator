import { defineConfig } from '@playwright/test';

// Electron end-to-end tests. `pnpm test:e2e` builds the app first.
export default defineConfig({
  timeout: 60_000,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: { trace: 'retain-on-failure' },
  projects: [
    { name: 'smoke', testDir: 'e2e' },
    // Environment suites live beside the code they drive.
    { name: 'app', testDir: 'apps/desktop/src', testMatch: '**/*.playwright.ts' },
  ],
});
