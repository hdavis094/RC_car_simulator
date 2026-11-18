import { Track } from '@rcsim/schema';
import type { TrackLibrary } from '../api/world.ts';
import oval from '../../assets/tracks/oval.json' with { type: 'json' };
import technical from '../../assets/tracks/technical.json' with { type: 'json' };

// The built-in tracks (assets/tracks/<id>.json). Imported rather than read from
// disk, so the library works unchanged in a bundle.
const SOURCES: Readonly<Record<string, unknown>> = { oval, technical };

const cache = new Map<string, Track>();

export const trackLibrary: TrackLibrary = {
  ids: () => Object.keys(SOURCES),
  load(id: string): Track {
    const cached = cache.get(id);
    if (cached) return cached;
    const source = SOURCES[id];
    if (source === undefined) {
      throw new Error(`unknown track "${id}" (built in: ${Object.keys(SOURCES).join(', ')})`);
    }
    const track = Track.parse(source);
    cache.set(id, track);
    return track;
  },
};
