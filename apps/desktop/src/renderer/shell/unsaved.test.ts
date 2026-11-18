import { beforeEach, describe, expect, it } from 'vitest';
import { createFakeRcsimApi } from '../../shared/fake-api.ts';
import { useEditorStore } from '../terminal/editor-state.ts';
import { resetWorkbenchStore, useWorkbenchStore } from '../workbench/workbench-store.ts';
import { hasUnsavedChanges } from './unsaved.ts';

describe('hasUnsavedChanges', () => {
  beforeEach(() => {
    useEditorStore.getState().reset();
    resetWorkbenchStore();
  });

  it('is false when neither the editor nor the Workbench has edits', () => {
    expect(hasUnsavedChanges()).toBe(false);
  });

  it('counts an unsaved editor document', async () => {
    const fake = createFakeRcsimApi();
    await useEditorStore.getState().open(fake.api, 'src/main.cpp');
    useEditorStore.getState().edit('src/main.cpp', 'unsaved');
    expect(hasUnsavedChanges()).toBe(true);
  });

  it('counts unsaved Workbench edits', () => {
    useWorkbenchStore.setState({ dirty: true });
    expect(hasUnsavedChanges()).toBe(true);
  });
});
