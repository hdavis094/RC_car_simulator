import { PartDefinition } from './part-definition.ts';

/** The part definitions available to a car project, by id. */
export type Catalog = ReadonlyMap<string, PartDefinition>;

/** A part definition file that failed to load. */
export interface CatalogProblem {
  readonly source: string;
  readonly message: string;
}

export class CatalogError extends Error {
  readonly problems: readonly CatalogProblem[];

  constructor(problems: readonly CatalogProblem[]) {
    super(
      `invalid part definitions:\n${problems.map((p) => `  ${p.source}: ${p.message}`).join('\n')}`,
    );
    this.name = 'CatalogError';
    this.problems = problems;
  }
}

/** A part definition file's contents and where it came from (for messages). */
export interface CatalogEntry {
  readonly source: string;
  readonly data: unknown;
}

/**
 * Validates part definition files and builds a catalog, on top of `base` if
 * given. Throws a `CatalogError` listing every invalid file and every id that
 * appears twice; custom parts may not reuse a built-in id.
 */
export function createCatalog(entries: readonly CatalogEntry[], base?: Catalog): Catalog {
  const catalog = new Map(base);
  const problems: CatalogProblem[] = [];
  for (const { source, data } of entries) {
    const result = PartDefinition.safeParse(data);
    if (!result.success) {
      for (const issue of result.error.issues) {
        const path = issue.path.length > 0 ? `${issue.path.join('.')}: ` : '';
        problems.push({ source, message: `${path}${issue.message}` });
      }
      continue;
    }
    if (catalog.has(result.data.id)) {
      problems.push({ source, message: `part id "${result.data.id}" is already in the catalog` });
      continue;
    }
    catalog.set(result.data.id, result.data);
  }
  if (problems.length > 0) throw new CatalogError(problems);
  return catalog;
}
