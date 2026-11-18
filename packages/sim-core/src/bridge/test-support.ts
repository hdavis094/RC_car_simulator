// Helpers for the bridge's tests: build the sketches in fixtures/ with hal's
// build-sim, and run them in a real Run. Not part of the package's API.
import { execFile } from 'node:child_process';
import { cp, mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { Run, RunEnd } from '../api/run.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const buildSim = path.resolve(here, '../../../hal/bin/build-sim');
const run = promisify(execFile);

/** Builds `fixtures/<name>/main.cpp` in a scratch project and returns the firmware binary and the project. */
export async function buildSketch(
  name: string,
): Promise<{ readonly binary: string; readonly project: string }> {
  const project = await mkdtemp(path.join(tmpdir(), `rcsim-sketch-${name}-`));
  await mkdir(path.join(project, 'src'));
  await cp(path.join(here, 'fixtures', name, 'main.cpp'), path.join(project, 'src', 'main.cpp'));
  try {
    await run(process.execPath, [buildSim, project], { maxBuffer: 16 * 1024 * 1024 });
  } catch (error) {
    const e = error as { stderr?: string; message: string };
    throw new Error(`build-sim failed for "${name}": ${e.stderr ?? e.message}`, { cause: error });
  }
  return { binary: path.join(project, '.rcsim', 'build', 'firmware'), project };
}

export const removeProject = (project: string): Promise<void> =>
  rm(project, { recursive: true, force: true });

/** Everything a run emitted that the app would show. */
export interface Capture {
  readonly serial: { readonly tUs: number; readonly text: string }[];
  readonly ends: RunEnd[];
  text(): string;
}

/** Subscribes to a run's serial output and end. */
export function capture(target: Run): Capture {
  const serial: { tUs: number; text: string }[] = [];
  const ends: RunEnd[] = [];
  const decoder = new TextDecoder();
  target.on('serial', (bytes, tUs) => serial.push({ tUs, text: decoder.decode(bytes) }));
  target.on('end', (end) => ends.push(end));
  return { serial, ends, text: () => serial.map((s) => s.text).join('') };
}
