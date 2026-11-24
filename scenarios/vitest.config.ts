import { defineProject } from 'vitest/config';

// Not in the root Vitest projects: the v1 gate runs 60 s of sim with real
// firmware, so it runs under `pnpm test:scenarios`, not `pnpm test:unit`.
export default defineProject({
  test: { name: 'scenarios', include: ['*.test.ts'] },
});
