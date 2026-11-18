import { readdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';

// Killed builders cannot run finally. Leave recent builders alone and collect
// abandoned private builds only on cold cache builds.
export function removeStaleBuilds(directory, now = Date.now()) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('.hal-')) continue;
    const temporary = path.join(directory, entry.name);
    try {
      if (now - statSync(temporary).mtimeMs > 60 * 60 * 1000) {
        rmSync(temporary, { recursive: true, force: true });
      }
    } catch (error) {
      // A concurrent builder may have published or removed its directory.
      if (error.code !== 'ENOENT') throw error;
    }
  }
}
