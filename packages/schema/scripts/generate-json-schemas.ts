// Writes json-schema/*.schema.json from the Zod schemas. Run after changing a
// schema: `pnpm --filter @rcsim/schema generate`. A test fails while they differ.
// Output is Prettier-formatted so `pnpm format:check` passes.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { format, resolveConfig } from 'prettier';
import { JSON_SCHEMA_FILES, jsonSchemaText } from '../src/json-schemas.ts';

const dir = join(import.meta.dirname, '..', 'json-schema');
mkdirSync(dir, { recursive: true });
for (const file of Object.keys(JSON_SCHEMA_FILES) as (keyof typeof JSON_SCHEMA_FILES)[]) {
  const path = join(dir, file);
  const options = (await resolveConfig(path)) ?? {};
  writeFileSync(path, await format(jsonSchemaText(file), { ...options, filepath: path }));
  console.log(`wrote json-schema/${file}`);
}
