import type { Unsubscribe } from '../../shared/ipc.ts';

/** Main-side subscriptions; listeners never receive Electron event objects. */
export class Signal<Args extends unknown[]> {
  private readonly listeners = new Set<(...args: Args) => void>();
  readonly subscribe = (listener: (...args: Args) => void): Unsubscribe => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  emit(...args: Args): void {
    for (const listener of this.listeners) listener(...args);
  }
}
