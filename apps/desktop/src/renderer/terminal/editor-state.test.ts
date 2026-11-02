import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeRcsimApi } from '../../shared/fake-api.ts';
import { hasDirtyDocuments, useEditorStore } from './editor-state.ts';

const path = 'src/main.cpp';
describe('editor document conflicts', () => {
  beforeEach(() => useEditorStore.getState().reset());
  afterEach(() => vi.unstubAllGlobals());
  it('reloads clean documents and preserves unsaved contents when disk changes', async () => {
    const fake = createFakeRcsimApi();
    const editor = useEditorStore.getState();
    await editor.open(fake.api, path);
    await fake.api.project.writeFile(path, 'external');
    await editor.reload(fake.api, path);
    expect(useEditorStore.getState().documents[0]).toMatchObject({
      text: 'external',
      saved: 'external',
      conflict: false,
    });
    editor.edit(path, 'unsaved');
    await fake.api.project.writeFile(path, 'changed again');
    await editor.reload(fake.api, path);
    expect(useEditorStore.getState().documents[0]).toMatchObject({
      text: 'unsaved',
      saved: 'external',
      conflict: true,
    });
    expect(hasDirtyDocuments()).toBe(true);
  });
  it('requires a conflict choice and clears the conflict only after a successful save', async () => {
    const fake = createFakeRcsimApi();
    const editor = useEditorStore.getState();
    const confirm = vi.fn(() => false);
    vi.stubGlobal('window', { confirm });
    await editor.open(fake.api, path);
    editor.edit(path, 'unsaved');
    await fake.api.project.writeFile(path, 'external');
    await editor.reload(fake.api, path);
    await expect(editor.save(fake.api, path)).rejects.toThrow('Save cancelled');
    expect(await fake.api.project.readFile(path)).toBe('external');
    expect(hasDirtyDocuments()).toBe(true);
    confirm.mockReturnValue(true);
    await editor.save(fake.api, path);
    expect(await fake.api.project.readFile(path)).toBe('unsaved');
    expect(useEditorStore.getState().documents[0]).toMatchObject({
      saved: 'unsaved',
      conflict: false,
    });
    expect(hasDirtyDocuments()).toBe(false);
  });
  it('does not mark newer in-memory edits as saved when a write is pending', async () => {
    const fake = createFakeRcsimApi();
    const editor = useEditorStore.getState();
    await editor.open(fake.api, path);
    editor.edit(path, 'first edit');
    let finish: () => void = () => {};
    const write = vi.spyOn(fake.api.project, 'writeFile').mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const saving = editor.save(fake.api, path);
    editor.edit(path, 'newer edit');
    finish();
    await saving;
    expect(write).toHaveBeenCalledWith(path, 'first edit');
    expect(useEditorStore.getState().documents[0]).toMatchObject({
      text: 'newer edit',
      saved: 'first edit',
    });
    expect(hasDirtyDocuments()).toBe(true);
  });
  it('preserves the dirty state if a save fails', async () => {
    const fake = createFakeRcsimApi();
    const editor = useEditorStore.getState();
    await editor.open(fake.api, path);
    editor.edit(path, 'unsaved');
    vi.spyOn(fake.api.project, 'writeFile').mockRejectedValue(new Error('disk full'));
    await expect(editor.save(fake.api, path)).rejects.toThrow('disk full');
    expect(hasDirtyDocuments()).toBe(true);
  });
});
