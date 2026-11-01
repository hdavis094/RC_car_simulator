import { describe, expect, it } from 'vitest';
import { PACKAGE_NAME } from './index.ts';

describe('@rcsim/sim-core stub', () => {
  it('loads', () => {
    expect(PACKAGE_NAME).toBe('@rcsim/sim-core');
  });
});
