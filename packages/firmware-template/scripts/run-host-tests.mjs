import { spawn } from 'node:child_process';

export function runHostTests(
  executable,
  args,
  { timeoutMs = 60_000, stdout = process.stdout, stderr = process.stderr, ...options } = {},
) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      ...options,
      detached: true, // POSIX process group includes the fake-sim firmware child.
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let currentCase = '<before first case>';
    let lastCase = currentCase;
    let pending = '';
    let timedOut = false;
    child.stdout.on('data', (chunk) => stdout.write(chunk));
    child.stderr.on('data', (chunk) => {
      stderr.write(chunk);
      pending += chunk.toString();
      let end;
      while ((end = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, end);
        pending = pending.slice(end + 1);
        if (line.startsWith('[starter-test] RUN ')) {
          currentCase = line.slice('[starter-test] RUN '.length);
          lastCase = currentCase;
        } else if (line.startsWith('[starter-test] DONE ')) {
          currentCase = '<between test cases>';
        }
      }
    });
    const timer = setTimeout(() => {
      timedOut = true;
      stderr.write(`Host tests timed out after ${timeoutMs} ms; running case: ${currentCase}\n`);
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch (error) {
        if (error.code !== 'ESRCH') child.kill('SIGKILL');
      }
    }, timeoutMs);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(
          new Error(
            `${executable} timed out after ${timeoutMs} ms; running case: ${currentCase}; last case: ${lastCase}`,
          ),
        );
      } else if (code !== 0) {
        reject(new Error(`${executable} exited ${code ?? signal}; last case: ${lastCase}`));
      } else {
        resolve();
      }
    });
  });
}
