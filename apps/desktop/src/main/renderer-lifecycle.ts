import type { WebContents } from 'electron';

/** Renderer-owned processes must end even when a reload/crash skips React cleanup. */
export function disposeRendererResources(
  contents: WebContents,
  resources: readonly { dispose(): void }[],
): () => void {
  const dispose = (): void => {
    for (const resource of resources) resource.dispose();
  };
  const navigating = (
    details: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>,
  ): void => {
    if (details.isMainFrame && !details.isSameDocument) dispose();
  };
  contents.on('did-start-navigation', navigating);
  contents.on('render-process-gone', dispose);
  return () => {
    contents.off('did-start-navigation', navigating);
    contents.off('render-process-gone', dispose);
  };
}
