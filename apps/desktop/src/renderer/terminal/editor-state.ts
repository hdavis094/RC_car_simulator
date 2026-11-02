import { create } from 'zustand';
import type { Diagnostic, RcsimApi } from '../../shared/ipc.ts';

export interface Document {
  readonly path: string;
  readonly text: string;
  readonly saved: string;
  readonly conflict: boolean;
}
interface EditorState {
  documents: readonly Document[];
  active: string | null;
  location: { path: string; line: number; column: number; token: number } | null;
  open: (api: RcsimApi, path: string, diagnostic?: Diagnostic) => Promise<void>;
  edit: (path: string, text: string) => void;
  save: (api: RcsimApi, path: string) => Promise<void>;
  saveAll: (api: RcsimApi) => Promise<void>;
  reload: (api: RcsimApi, path: string) => Promise<void>;
  close: (path: string) => void;
  reset: () => void;
}
export const useEditorStore = create<EditorState>((set, get) => ({
  documents: [],
  active: null,
  location: null,
  open: async (api, path, diagnostic) => {
    if (!get().documents.some((doc) => doc.path === path)) {
      const text = await api.project.readFile(path);
      set((state) => ({
        documents: state.documents.some((doc) => doc.path === path)
          ? state.documents
          : [...state.documents, { path, text, saved: text, conflict: false }],
      }));
    }
    set({
      active: path,
      ...(diagnostic
        ? {
            location: { path, line: diagnostic.line, column: diagnostic.column, token: Date.now() },
          }
        : {}),
    });
  },
  edit: (path, text) =>
    set((state) => ({
      documents: state.documents.map((doc) => (doc.path === path ? { ...doc, text } : doc)),
    })),
  save: async (api, path) => {
    const doc = get().documents.find((doc) => doc.path === path);
    if (!doc || doc.text === doc.saved) return;
    if (
      doc.conflict &&
      !window.confirm(`${path} changed on disk. Overwrite it with the editor contents?`)
    )
      throw new Error('Save cancelled. Reload the file to use the disk version.');
    await api.project.writeFile(path, doc.text);
    set((state) => ({
      documents: state.documents.map((current) =>
        current.path === path ? { ...current, saved: doc.text, conflict: false } : current,
      ),
    }));
  },
  saveAll: async (api) => {
    for (const doc of get().documents) await get().save(api, doc.path);
  },
  reload: async (api, path) => {
    if (!get().documents.some((doc) => doc.path === path)) return;
    const text = await api.project.readFile(path);
    set((state) => ({
      documents: state.documents.map((doc) => {
        if (doc.path !== path || doc.saved === text) return doc;
        return doc.text === doc.saved
          ? { ...doc, text, saved: text, conflict: false }
          : { ...doc, conflict: true };
      }),
    }));
  },
  close: (path) =>
    set((state) => {
      const documents = state.documents.filter((doc) => doc.path !== path);
      return {
        documents,
        active: state.active === path ? (documents.at(-1)?.path ?? null) : state.active,
      };
    }),
  reset: () => set({ documents: [], active: null, location: null }),
}));
export const hasDirtyDocuments = (): boolean =>
  useEditorStore.getState().documents.some((doc) => doc.text !== doc.saved);
