import { describe, expect, it } from 'vitest';
import { PACKAGE_NAME } from './index.ts';

describe('@rcsim/control-protocol stub', () => {
  it('loads', () => {
    expect(PACKAGE_NAME).toBe('@rcsim/control-protocol');
  });
});
