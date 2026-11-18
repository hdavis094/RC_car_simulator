import { hasDirtyDocuments } from '../terminal/editor-state.ts';
import { hasUnsavedWorkbenchChanges } from '../workbench/workbench-store.ts';

/** True when any environment holds edits that switching project or closing the window would lose. */
export const hasUnsavedChanges = (): boolean => hasDirtyDocuments() || hasUnsavedWorkbenchChanges();
