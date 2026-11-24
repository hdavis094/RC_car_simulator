// The v1 scenario (docs/tasks/P2-01-integration.md): the starter firmware
// drives the oval with the fixed cone layout for 60 s of sim time.
//
//   node scenarios/run.ts                  seed 1, checked against v1.expected.json
//   node scenarios/run.ts --seeds 1-10     one JSON line per seed; only seed 1 gates
//   node scenarios/run.ts --write-expected record seed 1's result as v1.expected.json
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseAssertion,
  runScenario,
  type ScenarioResult,
  type ScenarioSpec,
} from '@rcsim/sim-core';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');
const template = path.join(repo, 'packages', 'firmware-template');
const buildSim = path.join(repo, 'packages', 'hal', 'bin', 'build-sim');

/** What the gate compares across runs and platforms. */
export interface V1Fingerprint {
  readonly laps: number;
  readonly collisions: number;
  readonly serialHash: string;
}

export function fingerprint(result: ScenarioResult): V1Fingerprint {
  return {
    laps: result.metrics.laps,
    collisions: result.metrics.collisions,
    serialHash: result.serialHash,
  };
}

/** Files of the template that are the car project (as a new project gets them). */
const PROJECT_ENTRIES = ['car.json', 'platformio.ini', 'include', 'src'];

let firmware: Promise<string> | undefined;

/**
 * Builds the starter firmware once per process, in a temp copy so nothing is
 * ever written into packages/firmware-template.
 */
function buildFirmware(): Promise<string> {
  firmware ??= Promise.resolve().then(() => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'rcsim-v1-'));
    process.once('exit', () => rmSync(dir, { recursive: true, force: true }));
    for (const entry of PROJECT_ENTRIES) {
      cpSync(path.join(template, entry), path.join(dir, entry), { recursive: true });
    }
    const built = spawnSync(process.execPath, [buildSim, dir], { encoding: 'utf8' });
    if (built.error) throw built.error;
    if (built.status !== 0) {
      throw new Error(`build-sim failed (${built.status}):\n${built.stdout}${built.stderr}`);
    }
    return path.join(dir, '.rcsim', 'build', 'firmware');
  });
  return firmware;
}

interface V1File extends Omit<ScenarioSpec, 'assertions' | 'firmware'> {
  readonly assertions: readonly string[];
}

/** Runs the v1 scenario with `seed` in place of the spec's. Paths resolve from scenarios/. */
export async function runV1(options: { seed: number }): Promise<ScenarioResult> {
  const file = JSON.parse(readFileSync(path.join(here, 'v1.json'), 'utf8')) as V1File;
  const spec: ScenarioSpec = {
    ...file,
    seed: options.seed,
    firmware: await buildFirmware(),
    assertions: file.assertions.map(parseAssertion),
  };
  return runScenario(spec, { cwd: here });
}

function parseSeeds(text: string): number[] {
  const range = /^(\d+)-(\d+)$/.exec(text);
  if (range) {
    const [from, to] = [Number(range[1]), Number(range[2])];
    if (from > to || to > 0xffff_ffff) throw new Error(`Invalid seed range "${text}".`);
    return Array.from({ length: to - from + 1 }, (_, i) => from + i);
  }
  return text.split(',').map((seed) => {
    if (!/^\d+$/.test(seed) || Number(seed) > 0xffff_ffff)
      throw new Error(`bad --seeds "${text}": expected "1-10" or "1,3,5"`);
    return Number(seed);
  });
}

async function main(args: readonly string[]): Promise<number> {
  const at = args.indexOf('--seeds');
  const seeds = at >= 0 ? parseSeeds(args[at + 1] ?? '') : [1];
  const write = args.includes('--write-expected');
  if (write && !seeds.includes(1)) throw new Error('--write-expected requires seed 1.');
  const expectedFile = path.join(here, 'v1.expected.json');
  let code = 0;
  for (const seed of seeds) {
    const result = await runV1({ seed });
    const print = fingerprint(result);
    console.log(
      JSON.stringify({
        seed,
        passed: result.passed,
        ...print,
        end: result.end,
        wallMs: result.wallMs,
      }),
    );
    if (seed !== 1) continue;
    if (!result.passed || result.end.kind !== 'stopped') {
      console.error('v1 scenario: seed 1 failed its assertions');
      code = 1;
      continue;
    }
    if (write) {
      writeFileSync(expectedFile, `${JSON.stringify(print, null, 2)}\n`);
      continue;
    }
    const expected = JSON.parse(readFileSync(expectedFile, 'utf8')) as V1Fingerprint;
    if (!sameFingerprint(print, expected)) {
      console.error(
        `v1 scenario: seed 1 deviates from v1.expected.json: ${JSON.stringify(expected)}`,
      );
      code = 1;
    }
  }
  return code;
}

function sameFingerprint(a: V1Fingerprint, b: V1Fingerprint): boolean {
  return a.laps === b.laps && a.collisions === b.collisions && a.serialHash === b.serialHash;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
