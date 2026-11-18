import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, existsSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { compilerWords, makeCompiler } from '../scripts/compiler-command.mjs';
import { removeStaleBuilds } from '../scripts/build-cache.mjs';

test('compiler words preserve launcher arguments, quoted paths and literal substitutions', () => {
  assert.deepEqual(compilerWords('ccache g++'), ['ccache', 'g++']);
  assert.deepEqual(compilerWords('"/path with spaces/compiler" -DNAME=one\\ two'), [
    '/path with spaces/compiler',
    '-DNAME=one two',
  ]);
  assert.deepEqual(compilerWords('\'$(literal)\' -DVALUE="two words"'), [
    '$(literal)',
    '-DVALUE=two words',
  ]);
  assert.throws(() => compilerWords("'unfinished"));
  assert.throws(() => compilerWords(''));
  assert.equal(makeCompiler(['a$b', "c'd"]), "'a$$b' 'c'\\''d'");
});
test('cold-build cleanup removes only old private HAL build directories', () => {
  const build = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../build');
  mkdirSync(build, { recursive: true });
  const directory = mkdtempSync(path.join(build, 'cache-cleanup-test-'));
  try {
    const stale = path.join(directory, '.hal-abandoned');
    const recent = path.join(directory, '.hal-active');
    const published = path.join(directory, 'published');
    for (const dir of [stale, recent, published]) mkdirSync(dir);
    writeFileSync(path.join(stale, 'partial.o'), 'incomplete');
    writeFileSync(path.join(directory, '.hal-file'), 'leave files alone');
    const now = Date.now(),
      old = new Date(now - 2 * 60 * 60 * 1000);
    utimesSync(stale, old, old);
    utimesSync(published, old, old);
    removeStaleBuilds(directory, now);
    assert.equal(existsSync(stale), false);
    assert.equal(existsSync(recent), true);
    assert.equal(existsSync(published), true);
    assert.equal(existsSync(path.join(directory, '.hal-file')), true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
