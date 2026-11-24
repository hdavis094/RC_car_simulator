import { utilityProcess } from 'electron';
import type { HostChannel, HostEvent } from './host-protocol.ts';

export function spawnUtilityHost(entry: string): HostChannel {
  const child = utilityProcess.fork(entry, [], { serviceName: 'Donkey Car Simulator' });
  return {
    send: (command) => child.postMessage(command),
    onMessage(listener) {
      const receive = (event: HostEvent): void => listener(event);
      child.on('message', receive);
      return () => child.off('message', receive);
    },
    onExit(listener) {
      child.once('exit', listener);
      return () => child.off('exit', listener);
    },
    kill: () => {
      child.kill();
    },
  };
}
