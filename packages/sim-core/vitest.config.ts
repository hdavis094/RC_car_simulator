import { defineProject } from 'vitest/config';

export default defineProject({
  test: { name: 'sim-core', include: ['src/**/*.test.ts'] },
});
