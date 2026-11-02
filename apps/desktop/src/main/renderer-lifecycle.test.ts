import { EventEmitter } from 'node:events';
import { expect, it, vi } from 'vitest';
import type { WebContents } from 'electron';
import { disposeRendererResources } from './renderer-lifecycle.ts';

it('disposes shells and builds on reload and crash, but preserves them for subframes/anchors', () => {
  const contents = new EventEmitter();
  const build = { dispose: vi.fn() };
  const pty = { dispose: vi.fn() };
  const remove = disposeRendererResources(contents as unknown as WebContents, [build, pty]);
  contents.emit('did-start-navigation', { isMainFrame: false, isSameDocument: false });
  contents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true });
  expect(build.dispose).not.toHaveBeenCalled();
  expect(pty.dispose).not.toHaveBeenCalled();
  contents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
  expect(build.dispose).toHaveBeenCalledTimes(1);
  expect(pty.dispose).toHaveBeenCalledTimes(1);
  contents.emit('render-process-gone', {}, { reason: 'crashed' });
  expect(build.dispose).toHaveBeenCalledTimes(2);
  expect(pty.dispose).toHaveBeenCalledTimes(2);
  remove();
  expect(contents.listenerCount('did-start-navigation')).toBe(0);
  expect(contents.listenerCount('render-process-gone')).toBe(0);
});
