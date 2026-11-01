import { z } from 'zod';
import { Car } from './car.ts';
import { PartDefinition } from './part-definition.ts';
import { Track } from './track.ts';
import { World } from './world.ts';

/** The data files described by JSON Schemas in `json-schema/`, for non-TS tools. */
export const JSON_SCHEMA_FILES = {
  'part-definition.schema.json': { schema: PartDefinition, title: 'Part definition' },
  'car.schema.json': { schema: Car, title: 'car.json' },
  'world.schema.json': { schema: World, title: 'World' },
  'track.schema.json': { schema: Track, title: 'Track' },
} as const;

/**
 * JSON Schema text for one data file. Zod refinements (cross-field checks) are
 * not expressible in JSON Schema, so a file can pass the JSON Schema and still
 * fail the Zod parse; the Zod schemas are authoritative.
 */
export function jsonSchemaText(file: keyof typeof JSON_SCHEMA_FILES): string {
  const { schema, title } = JSON_SCHEMA_FILES[file];
  const json = z.toJSONSchema(schema, { io: 'input', target: 'draft-2020-12' });
  return `${JSON.stringify({ title, ...json }, null, 2)}\n`;
}
