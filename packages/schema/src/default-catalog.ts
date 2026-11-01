import esp32DevkitcV4 from '../catalog/controller.esp32-devkitc-v4.json' with { type: 'json' };
import traxxasSlash2wd from '../catalog/chassis.traxxas-slash-2wd.json' with { type: 'json' };
import mg996r from '../catalog/actuator.mg996r.json' with { type: 'json' };
import quicrun1060 from '../catalog/actuator.quicrun-1060-540.json' with { type: 'json' };
import vl53l0x from '../catalog/sensor.vl53l0x-pololu.json' with { type: 'json' };
import hcSr04 from '../catalog/sensor.hc-sr04.json' with { type: 'json' };
import gy521 from '../catalog/sensor.gy-521-mpu6050.json' with { type: 'json' };
import lipo2s from '../catalog/power.lipo-2s-5000.json' with { type: 'json' };
import d24v22f5 from '../catalog/power.pololu-d24v22f5.json' with { type: 'json' };
import divider1k2k from '../catalog/passive.divider-1k-2k.json' with { type: 'json' };
import divider100k33k from '../catalog/passive.divider-100k-33k.json' with { type: 'json' };
import { createCatalog, type Catalog, type CatalogEntry } from './catalog.ts';

/** The built-in part definition files, as loaded from `catalog/`. */
export const DEFAULT_CATALOG_ENTRIES: readonly CatalogEntry[] = [
  { source: 'catalog/controller.esp32-devkitc-v4.json', data: esp32DevkitcV4 },
  { source: 'catalog/chassis.traxxas-slash-2wd.json', data: traxxasSlash2wd },
  { source: 'catalog/actuator.mg996r.json', data: mg996r },
  { source: 'catalog/actuator.quicrun-1060-540.json', data: quicrun1060 },
  { source: 'catalog/sensor.vl53l0x-pololu.json', data: vl53l0x },
  { source: 'catalog/sensor.hc-sr04.json', data: hcSr04 },
  { source: 'catalog/sensor.gy-521-mpu6050.json', data: gy521 },
  { source: 'catalog/power.lipo-2s-5000.json', data: lipo2s },
  { source: 'catalog/power.pololu-d24v22f5.json', data: d24v22f5 },
  { source: 'catalog/passive.divider-1k-2k.json', data: divider1k2k },
  { source: 'catalog/passive.divider-100k-33k.json', data: divider100k33k },
];

/** The built-in parts catalog. Extend it with custom parts via `createCatalog(entries, defaultCatalog)`. */
export const defaultCatalog: Catalog = createCatalog(DEFAULT_CATALOG_ENTRIES);
