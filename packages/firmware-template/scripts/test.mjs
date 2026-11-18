import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runHostTests } from './run-host-tests.mjs';
import { compilerWords } from '../../hal/scripts/compiler-command.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hal = path.resolve(root, '../hal');
const build = path.join(root, '.rcsim/host-tests');
mkdirSync(build, { recursive: true });
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited ${result.status ?? result.signal}`);
}
run(process.execPath, ['--test', path.join(root, 'scripts/run-host-tests.test.mjs')]);
for (const [source, target] of [
  ['default-car.json', 'car.json'],
  ['default-car.car_config.h', 'include/car_config.h'],
]) {
  if (
    !readFileSync(path.resolve(root, '../schema/examples', source)).equals(
      readFileSync(path.join(root, target)),
    )
  )
    throw new Error(`${target} differs from schema's generated example; refresh both together`);
}
const formatFiles = ['src', 'test'].flatMap((dir) =>
  readdirSync(path.join(root, dir))
    .filter((name) => /\.(cpp|h)$/.test(name))
    .map((name) => path.join(root, dir, name)),
);
run(path.join(hal, 'node_modules/.bin/clang-format'), ['--dry-run', '--Werror', ...formatFiles]);
const seen = new Set();
let index = 0;
for (const cxx of [process.env.CXX || 'c++', 'g++', 'clang++']) {
  const [command, ...prefix] = compilerWords(cxx);
  const version = spawnSync(command, [...prefix, '--version'], { encoding: 'utf8' });
  if (version.error?.code === 'ENOENT' && cxx !== (process.env.CXX || 'c++')) continue;
  if (version.error || version.status !== 0)
    throw version.error || new Error(`${cxx}: cannot get version`);
  const identity = version.stdout.split('\n')[0].replace(/^\S+\s+/, '');
  if (seen.has(identity)) continue;
  seen.add(identity);
  console.log(`Starter firmware: ${cxx} (${identity})`);
  run(path.join(hal, 'bin/build-sim'), [root], {
    env: { ...process.env, CXX: cxx, CXXFLAGS: `${process.env.CXXFLAGS || ''} -Werror` },
  });
  const executable = path.join(build, `starter-tests-${index++}`);
  const flags = [
    ...(process.env.CPPFLAGS?.trim() ? compilerWords(process.env.CPPFLAGS) : []),
    ...(process.env.CXXFLAGS?.trim() ? compilerWords(process.env.CXXFLAGS) : []),
  ];
  run(command, [
    ...prefix,
    '-std=c++17',
    '-O1',
    '-g',
    '-Wall',
    '-Wextra',
    '-Wpedantic',
    '-Werror',
    '-I',
    path.join(root, 'src'),
    '-I',
    path.join(hal, 'include'),
    '-I',
    path.join(hal, 'test'),
    '-isystem',
    path.join(hal, 'third_party'),
    '-isystem',
    path.join(hal, 'libraries/ArduinoJson'),
    ...flags,
    ...['avoidance.cpp', 'commands.cpp', 'control.cpp', 'outbound.cpp'].map((name) =>
      path.join(root, 'src', name),
    ),
    ...readdirSync(path.join(root, 'test'))
      .filter((name) => name.endsWith('.cpp'))
      .map((name) => path.join(root, 'test', name)),
    path.join(hal, 'src/protocol.cpp'),
    '-o',
    executable,
  ]);
  await runHostTests(executable, ['--duration=true', '--no-colors=true'], {
    cwd: hal,
    env: { ...process.env, STARTER_PROJECT: root },
  });
}
if (!seen.size) throw new Error('No C++ compiler found');
