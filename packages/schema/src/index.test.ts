import { describe, expect, it } from 'vitest';
import { PACKAGE_NAME } from './index.ts';

describe('@rcsim/schema stub', () => {
  it('loads', () => {
    expect(PACKAGE_NAME).toBe('@rcsim/schema');
  });
});
