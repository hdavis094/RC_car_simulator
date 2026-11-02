import { defineConfig } from '@playwright/test';

// Kept in P1-D's owned paths; P2-01 can move these into the shared e2e suite.
export default defineConfig({
  testDir: '.',
  testMatch: 'app.playwright.ts',
  timeout: 60_000,
  workers: 1,
  outputDir: '../../test-results',
  reporter: 'list',
  use: { trace: 'retain-on-failure' },
});
