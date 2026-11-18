import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runHostTests } from './run-host-tests.mjs';

const quiet = { stdout: { write() {} }, stderr: { write() {} } };
test(
  'watchdog reports the active case and kills the whole test process group',
  { timeout: 5000 },
  async () => {
    const script = `
    const { spawn } = require('node:child_process');
    spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit' });
    process.stderr.write('[starter-test] RUN deliberately stuck socket case\\n');
    setInterval(() => {}, 1000);
  `;
    await assert.rejects(
      runHostTests(process.execPath, ['-e', script], { ...quiet, timeoutMs: 500 }),
      /timed out after 500 ms; running case: deliberately stuck socket case/,
    );
  },
);
test('successful host processes complete normally', { timeout: 5000 }, async () => {
  await runHostTests(process.execPath, ['-e', 'process.exit(0)'], { ...quiet, timeoutMs: 2000 });
});
test('failed host processes report the last case', { timeout: 5000 }, async () => {
  await assert.rejects(
    runHostTests(
      process.execPath,
      ['-e', `process.stderr.write('[starter-test] RUN failed case\\n'); process.exit(7)`],
      { ...quiet, timeoutMs: 2000 },
    ),
    /exited 7; last case: failed case/,
  );
});
