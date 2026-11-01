import { beforeEach, describe, expect, it } from 'vitest';
import { useEnvironmentStore } from './environment-store.ts';

describe('environment store', () => {
  beforeEach(() => useEnvironmentStore.setState({ current: 'workbench' }));

  it('starts in the Workbench', () => {
    expect(useEnvironmentStore.getState().current).toBe('workbench');
  });

  it('switches environments', () => {
    useEnvironmentStore.getState().show('world');
    expect(useEnvironmentStore.getState().current).toBe('world');
  });
});
