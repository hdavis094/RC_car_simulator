import { defineProject } from 'vitest/config';

export default defineProject({
  test: { name: 'sim-protocol', include: ['src/**/*.test.ts'] },
});
