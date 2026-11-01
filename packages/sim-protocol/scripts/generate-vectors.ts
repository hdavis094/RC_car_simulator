// Writes vectors/*.bin + *.json and vectors/malformed/*.bin + *.json from
// scripts/vector-fixtures.ts: `pnpm --filter @rcsim/sim-protocol generate`.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { format, resolveConfig } from 'prettier';
import { encodeFrame } from '../src/codec.ts';
import { messageToJson } from '../src/json.ts';
import { MALFORMED_VECTORS, VALID_VECTORS } from './vector-fixtures.ts';

const root = join(import.meta.dirname, '..', 'vectors');
mkdirSync(join(root, 'malformed'), { recursive: true });

async function writeJson(path: string, value: unknown): Promise<void> {
  const options = (await resolveConfig(path)) ?? {};
  writeFileSync(path, await format(JSON.stringify(value), { ...options, filepath: path }));
}

for (const [name, message] of Object.entries(VALID_VECTORS)) {
  writeFileSync(join(root, `${name}.bin`), encodeFrame(message));
  await writeJson(join(root, `${name}.json`), messageToJson(message));
}
for (const [name, { bytes, description }] of Object.entries(MALFORMED_VECTORS)) {
  writeFileSync(join(root, 'malformed', `${name}.bin`), bytes);
  await writeJson(join(root, 'malformed', `${name}.json`), { error: 'malformed', description });
}
console.log(
  `wrote ${Object.keys(VALID_VECTORS).length} vectors and ${Object.keys(MALFORMED_VECTORS).length} malformed vectors`,
);
