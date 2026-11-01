import { describe, expect, it } from 'vitest';
import { CatalogError, createCatalog } from './catalog.ts';
import { DEFAULT_CATALOG_ENTRIES, defaultCatalog } from './default-catalog.ts';

const PRD_PARTS = [
  'controller.esp32-devkitc-v4',
  'chassis.traxxas-slash-2wd',
  'actuator.quicrun-1060-540',
  'actuator.mg996r',
  'sensor.vl53l0x-pololu',
  'sensor.hc-sr04',
  'sensor.gy-521-mpu6050',
  'power.lipo-2s-5000',
  'passive.divider-100k-33k',
  'power.pololu-d24v22f5',
  'passive.divider-1k-2k',
];

describe('default catalog', () => {
  it('has every part from the PRD table plus the HC-SR04 echo divider', () => {
    expect([...defaultCatalog.keys()].sort()).toEqual([...PRD_PARTS].sort());
  });

  it.each(DEFAULT_CATALOG_ENTRIES.map((e) => [e.source, e] as const))(
    '%s is named after its id and cites a datasheet',
    (source, entry) => {
      const id = (entry.data as { id: string }).id;
      expect(source).toBe(`catalog/${id}.json`);
      const part = defaultCatalog.get(id);
      expect(part?.sources.length).toBeGreaterThan(0);
      for (const url of part?.sources ?? []) expect(url).toMatch(/^https?:\/\//);
    },
  );
});

describe('createCatalog', () => {
  const vl53l0x = DEFAULT_CATALOG_ENTRIES.find((e) => e.source.includes('vl53l0x'))?.data as Record<
    string,
    unknown
  >;

  it('adds custom parts on top of the built-ins', () => {
    const custom = { ...vl53l0x, id: 'custom.my-tof', name: 'My ToF' };
    const catalog = createCatalog([{ source: 'parts/my-tof.json', data: custom }], defaultCatalog);
    expect(catalog.get('custom.my-tof')?.name).toBe('My ToF');
    expect(catalog.size).toBe(defaultCatalog.size + 1);
  });

  it('rejects a custom part that reuses a built-in id', () => {
    expect(() =>
      createCatalog([{ source: 'parts/dup.json', data: vl53l0x }], defaultCatalog),
    ).toThrow(CatalogError);
  });

  it('reports every invalid file with its source', () => {
    try {
      createCatalog([
        { source: 'parts/a.json', data: { ...vl53l0x, id: 'custom.a', massG: -1 } },
        { source: 'parts/b.json', data: { ...vl53l0x, id: 'custom.b', sources: [] } },
      ]);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(CatalogError);
      const sources = (error as CatalogError).problems.map((p) => p.source);
      expect(sources).toContain('parts/a.json');
      expect(sources).toContain('parts/b.json');
    }
  });
});
