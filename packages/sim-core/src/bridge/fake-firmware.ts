// A "firmware" written in JS for tests, to speak (or break) sim-protocol by hand.
import { chmod, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const protocol = fileURLToPath(new URL('../../../sim-protocol/src/index.ts', import.meta.url));

/**
 * Writes an executable script in `dir` and returns its path. `body` runs with
 * `send(message)`, `receive()`, `hello` and the connected `socket` in scope;
 * `encodeFrame` is there too, for writes that must arrive together.
 */
export async function fakeFirmware(dir: string, name: string, body: string): Promise<string> {
  const file = path.join(dir, name);
  await writeFile(
    file,
    `#!/usr/bin/env node
import net from 'node:net';
import { FrameDecoder, encodeFrame } from ${JSON.stringify(protocol)};
const socket = net.connect(process.env.RCSIM_SOCKET);
const decoder = new FrameDecoder();
const inbox = [];
let wake;
socket.on('data', (chunk) => { inbox.push(...decoder.push(chunk)); wake?.(); });
socket.on('close', () => process.exit(0));
const send = (m) => socket.write(encodeFrame(m));
const receive = async () => { while (!inbox.length) await new Promise((r) => (wake = r)); return inbox.shift(); };
const hello = { type: 'HELLO', protocolVersion: 1, halVersion: 'fake' };
const done = (tick) => ({ type: 'STEP_DONE', tick, pwm: [], gpioWrites: [], serialTx: new Uint8Array(), netEvents: [], logs: [] });
${body}
`,
  );
  await chmod(file, 0o755);
  return file;
}
