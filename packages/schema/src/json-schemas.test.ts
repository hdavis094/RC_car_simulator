import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { JSON_SCHEMA_FILES, jsonSchemaText } from './json-schemas.ts';

describe('json-schema/', () => {
  it.each(Object.keys(JSON_SCHEMA_FILES) as (keyof typeof JSON_SCHEMA_FILES)[])(
    '%s matches the Zod schema (run `pnpm --filter @rcsim/schema generate` if not)',
    (file) => {
      const committed = readFileSync(join(import.meta.dirname, '..', 'json-schema', file), 'utf8');
      expect(JSON.parse(committed)).toEqual(JSON.parse(jsonSchemaText(file)));
    },
  );
});
