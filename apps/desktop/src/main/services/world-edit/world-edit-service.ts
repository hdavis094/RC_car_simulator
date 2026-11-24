import { GroundPose, Obstacle, type Track, type World } from '@rcsim/schema';
import { trackLibrary } from '@rcsim/sim-core';
import type { WorldEditApi } from '../../../shared/ipc.ts';
import { fail } from '../errors.ts';
import type { ProjectService } from '../project.ts';
import {
  isLayoutPath,
  loadTrack,
  parseWorld,
  readWorld,
  requireLayoutPath,
} from './world-files.ts';

type LiveWorld = Pick<
  WorldEditApi,
  'addObstacle' | 'moveObstacle' | 'removeObstacle' | 'currentLayout'
>;

export class WorldEditService implements WorldEditApi {
  private readonly deps: {
    readonly project: Pick<ProjectService, 'listFiles' | 'readFile' | 'writeFile'>;
    readonly sim: LiveWorld;
  };

  constructor(deps: WorldEditService['deps']) {
    this.deps = deps;
  }

  async listTracks(): Promise<readonly string[]> {
    return trackLibrary.ids();
  }

  async loadTrack(id: string): Promise<Track> {
    return loadTrack(id);
  }

  async listLayouts(): Promise<readonly string[]> {
    const files = await this.deps.project.listFiles();
    return files
      .filter((entry) => entry.kind === 'file' && isLayoutPath(entry.path))
      .map((entry) => entry.path)
      .sort();
  }

  async load(path: string): Promise<World> {
    requireLayoutPath(path);
    return readWorld(await this.deps.project.readFile(path, 'worlds'));
  }

  async save(path: string, world: World): Promise<void> {
    requireLayoutPath(path);
    await this.deps.project.writeFile(
      path,
      `${JSON.stringify(parseWorld(world), null, 2)}\n`,
      'worlds',
    );
  }

  async addObstacle(obstacle: Obstacle): Promise<string> {
    const result = Obstacle.safeParse(obstacle);
    if (!result.success) fail('invalid', result.error.message);
    return this.deps.sim.addObstacle(result.data);
  }

  async moveObstacle(
    id: string,
    position: { x: number; z: number },
    yawDeg: number,
  ): Promise<void> {
    if (typeof id !== 'string' || !id) fail('invalid', 'Expected an obstacle id.');
    const result = GroundPose.safeParse({ positionM: position, yawDeg });
    if (!result.success) fail('invalid', result.error.message);
    await this.deps.sim.moveObstacle(id, result.data.positionM, result.data.yawDeg);
  }

  async removeObstacle(id: string): Promise<void> {
    if (typeof id !== 'string' || !id) fail('invalid', 'Expected an obstacle id.');
    await this.deps.sim.removeObstacle(id);
  }

  async currentLayout(): Promise<World> {
    return this.deps.sim.currentLayout();
  }
}
