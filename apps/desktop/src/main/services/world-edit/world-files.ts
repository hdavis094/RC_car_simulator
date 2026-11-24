import { World, type Track } from '@rcsim/schema';
import { trackLibrary } from '@rcsim/sim-core';
import { errorText, fail } from '../errors.ts';

export function loadTrack(id: string): Track {
  if (!trackLibrary.ids().includes(id)) fail('not-found', `Unknown track "${id}".`);
  return trackLibrary.load(id);
}

export function isLayoutPath(path: string): boolean {
  if (
    typeof path !== 'string' ||
    !path.startsWith('worlds/') ||
    path.includes('\\') ||
    path.includes(':') ||
    path.includes(String.fromCharCode(0))
  ) {
    return false;
  }
  const segments = path.split('/');
  return (
    segments.every((segment) => segment && segment !== '.' && segment !== '..') &&
    /.+\.json$/i.test(segments.at(-1) ?? '')
  );
}

export function requireLayoutPath(path: string): void {
  if (!isLayoutPath(path)) fail('invalid', 'Expected a JSON layout path inside worlds/.');
}

export function parseWorld(input: unknown): World {
  const result = World.safeParse(input);
  if (!result.success) fail('invalid', result.error.message);
  return result.data;
}

export function readWorld(text: string): World {
  let input: unknown;
  try {
    input = JSON.parse(text);
  } catch (error) {
    fail('invalid', errorText(error));
  }
  return parseWorld(input);
}
