import { defaultCatalog, PartDefinition } from '@rcsim/schema';
import type { CatalogApi, CatalogListing } from '../../shared/ipc.ts';
import { errorText, fail } from './errors.ts';
import { Signal } from './events.ts';
import type { ProjectService } from './project.ts';

export class CatalogService implements CatalogApi {
  private readonly changes = new Signal<[CatalogListing]>();
  readonly onChange = this.changes.subscribe;
  private readonly unsubscribe: () => void;
  private readonly project: ProjectService;
  constructor(project: ProjectService) {
    this.project = project;
    this.unsubscribe = project.onFileChange((change) => {
      if (change.path === 'parts' || change.path.startsWith('parts/')) {
        void this.list()
          .then((listing) => this.changes.emit(listing))
          .catch(() => {});
      }
    });
  }
  async list(): Promise<CatalogListing> {
    const custom: CatalogListing['custom'][number][] = [];
    const problems: CatalogListing['problems'][number][] = [];
    const ids = new Set(defaultCatalog.keys());
    const files = (await this.project.current()) ? await this.project.listFiles() : [];
    for (const entry of files) {
      if (entry.kind !== 'file' || !/^parts\/[^/]+\.json$/i.test(entry.path)) continue;
      try {
        const definition = PartDefinition.parse(
          JSON.parse(await this.project.readFile(entry.path)),
        );
        if (ids.has(definition.id))
          throw new Error(`Part id ${definition.id} is already in the catalog.`);
        ids.add(definition.id);
        custom.push({ path: entry.path, definition });
      } catch (error) {
        problems.push({ source: entry.path, message: errorText(error) });
      }
    }
    return { builtIn: [...defaultCatalog.values()], custom, problems };
  }
  async saveCustomPart(input: PartDefinition): Promise<{ readonly path: string }> {
    const result = PartDefinition.safeParse(input);
    if (!result.success) fail('invalid', result.error.message);
    if (defaultCatalog.has(result.data.id))
      fail('invalid', 'Custom parts cannot replace a built-in part.');
    const path = `parts/${result.data.id}.json`;
    const listing = await this.list();
    if (
      listing.custom.some((part) => part.definition.id === result.data.id && part.path !== path)
    ) {
      fail('invalid', 'That part id is already stored in another file.');
    }
    await this.project.writeFile(path, `${JSON.stringify(result.data, null, 2)}\n`);
    this.changes.emit(await this.list());
    return { path };
  }
  dispose(): void {
    this.unsubscribe();
  }
}
