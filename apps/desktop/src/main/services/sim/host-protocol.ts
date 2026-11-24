import type { Car, Catalog, Obstacle, Track, World } from '@rcsim/schema';
import type { StateSnapshot } from '@rcsim/sim-core';
import type { LogLine, NetFaults } from '@rcsim/sim-protocol';
import type { RunInfo, RunSpeed } from '../../../shared/ipc.ts';

export type HostAction =
  | {
      readonly type: 'start';
      readonly info: RunInfo;
      readonly car: Car;
      readonly catalog: Catalog;
      readonly world: World;
      readonly track: Track;
      readonly firmwarePath: string;
      readonly paused: boolean;
    }
  | { readonly type: 'stop' | 'pause' | 'resume' | 'restartFirmware' | 'currentLayout' }
  | { readonly type: 'step'; readonly ticks: number }
  | { readonly type: 'setSpeed'; readonly speed: RunSpeed }
  | { readonly type: 'setNetFaults'; readonly faults: NetFaults }
  | { readonly type: 'sendSerial'; readonly text: string }
  | { readonly type: 'addObstacle'; readonly obstacle: Obstacle }
  | {
      readonly type: 'moveObstacle';
      readonly id: string;
      readonly position: { readonly x: number; readonly z: number };
      readonly yawDeg: number;
    }
  | { readonly type: 'removeObstacle'; readonly id: string };

export type HostCommand = HostAction & { readonly requestId: number };

export type HostEvent =
  | {
      readonly type: 'reply';
      readonly requestId: number;
      readonly ok: true;
      readonly value: unknown;
    }
  | {
      readonly type: 'reply';
      readonly requestId: number;
      readonly ok: false;
      readonly error: string;
    }
  | { readonly type: 'status'; readonly info: RunInfo }
  | { readonly type: 'snapshot'; readonly snapshot: StateSnapshot }
  | { readonly type: 'serial'; readonly text: string; readonly tUs: number }
  | { readonly type: 'log'; readonly line: LogLine; readonly tUs: number };

export interface HostChannel {
  send(command: HostCommand): void;
  onMessage(listener: (event: HostEvent) => void): () => void;
  onExit(listener: () => void): () => void;
  kill(): void;
}
