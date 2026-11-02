import {
  Car,
  InstanceId,
  PartDefinition,
  canRun,
  carParts,
  checkWiring,
  defaultCatalog,
  exampleCar,
  type Catalog,
  type Issue,
  type Part,
  type PinTarget,
  type Placement,
} from '@rcsim/schema';
import { create } from 'zustand';
import { parseIpcError, type CatalogListing, type RcsimApi } from '../../shared/ipc.ts';

/** Formats a 7-bit I²C address in hex as in datasheets (`0x29`). */
export function formatHex(address: number): string {
  return `0x${address.toString(16).toUpperCase().padStart(2, '0')}`;
}

/**
 * Builds a Catalog Map from the catalog IPC listing, keeping built-ins first
 * and skipping any custom part whose id collides with a built-in or an earlier
 * custom part (matching `createCatalog` in `@rcsim/schema`).
 */
export function catalogFromListing(listing: CatalogListing): Catalog {
  const map = new Map<string, PartDefinition>();
  for (const part of listing.builtIn) {
    map.set(part.id, part);
  }
  for (const entry of listing.custom) {
    if (map.has(entry.definition.id)) continue;
    map.set(entry.definition.id, entry.definition);
  }
  return map;
}

const DEFAULT_LISTING: CatalogListing = {
  builtIn: [...defaultCatalog.values()],
  custom: [],
  problems: [],
};

const UNLOADED_CAR: Car = {
  schemaVersion: 1,
  name: '',
  wifi: true,
  controller: { instanceId: 'esp32', partId: 'controller.esp32-devkitc-v4' },
  chassis: { instanceId: 'chassis', partId: 'chassis.traxxas-slash-2wd' },
  parts: [],
};

let nextRowKeyCounter = 1;
function buildRowKeys(
  car: Car,
  existing: Readonly<Record<string, string>> = {},
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const part of [car.controller, car.chassis, ...car.parts]) {
    result[part.instanceId] = existing[part.instanceId] ?? `part-row-${nextRowKeyCounter++}`;
  }
  return result;
}

/** Converts an arbitrary string into a valid lowercase C-identifier base for an InstanceId. */
export function sanitizeInstanceIdBase(raw: string): string {
  const afterDot = raw.includes('.') ? (raw.split('.').pop() ?? raw) : raw;
  const cleaned = afterDot
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_+/g, '_');
  const prefixed = /^[a-z]/.test(cleaned) ? cleaned : `part_${cleaned || 'item'}`;
  return prefixed.slice(0, 28).replace(/_+$/, '') || 'part';
}

/** Generates a unique C-identifier-safe instance id for a newly added part. */
export function uniqueInstanceId(car: Car, partId: string, preferred?: string): string {
  const existing = new Set<string>([
    car.controller.instanceId,
    car.chassis.instanceId,
    ...car.parts.map((p) => p.instanceId),
  ]);
  const base = sanitizeInstanceIdBase(preferred && preferred.trim() ? preferred.trim() : partId);
  if (!existing.has(base) && InstanceId.safeParse(base).success) {
    return base;
  }
  let index = 2;
  while (existing.has(`${base}_${index}`)) {
    index++;
  }
  return `${base}_${index}`;
}

/**
 * Resolves the active RcsimApi: explicit `api` prop, else `window.rcsim` when
 * preload services are present, else throws `'rcsim API unavailable'`.
 */
export function resolveRcsimApi(explicit?: RcsimApi): RcsimApi {
  if (explicit) return explicit;
  if (
    typeof window !== 'undefined' &&
    'rcsim' in window &&
    window.rcsim &&
    typeof window.rcsim.project?.readCar === 'function' &&
    typeof window.rcsim.catalog?.list === 'function'
  ) {
    return window.rcsim;
  }
  throw new Error('rcsim API unavailable');
}

export interface SaveStatus {
  readonly ok: boolean;
  readonly flaggedErrors: number;
  readonly message: string;
}

export interface WorkbenchState {
  api: RcsimApi | null;
  car: Car;
  partRowKeys: Readonly<Record<string, string>>;
  listing: CatalogListing;
  catalog: Catalog;
  issues: readonly Issue[];
  loaded: boolean;
  dirty: boolean;
  saving: boolean;
  lastSavedCarJson: string | null;
  externalChange: boolean;
  saveStatus: SaveStatus | null;
  loadError: string | null;
  loadErrorRaw: string | null;
  searchQuery: string;
  selectedInstanceId: string | null;
  selectedPartId: string | null;
  focusedRowKey: string | null;
  newPartOpen: boolean;

  load: (api?: RcsimApi, options?: { readonly force?: boolean }) => Promise<void>;
  reloadFromDisk: () => Promise<void>;
  dismissExternalChange: () => void;
  handleExternalCarFileChange: () => Promise<void>;
  startFromExampleCar: () => void;
  updateCatalogListing: (listing: CatalogListing) => void;
  setSearchQuery: (query: string) => void;
  selectInstance: (instanceId: string) => void;
  selectCatalogPart: (partId: string) => void;
  setCarName: (name: string) => void;
  setCarWifi: (wifi: boolean) => void;
  addPart: (
    partId: string,
    requestedInstanceId?: string,
  ) => { ok: true; instanceId: string } | { ok: false; error: string };
  removePart: (instanceId: string) => void;
  renameInstance: (oldId: string, newId: string) => { ok: true } | { ok: false; error: string };
  assignPin: (instanceId: string, pinName: string, target: PinTarget | undefined) => void;
  setI2cAddress: (instanceId: string, address: number | undefined) => void;
  setPlacement: (instanceId: string, placement: Placement | undefined) => void;
  focusIssueRow: (rowKey: string | null) => void;
  setNewPartOpen: (open: boolean) => void;
  saveCar: () => Promise<boolean>;
  createCustomPart: (
    definition: PartDefinition,
  ) => Promise<{ ok: true; path: string } | { ok: false; error: string }>;
}

const initialCatalog = catalogFromListing(DEFAULT_LISTING);

const updateCarState = (
  car: Car,
  catalog: Catalog,
  extra?: Partial<WorkbenchState>,
): Partial<WorkbenchState> => ({
  car,
  issues: checkWiring(car, catalog),
  dirty: true,
  saveStatus: null,
  ...extra,
});

function createInitialState(): Omit<
  WorkbenchState,
  | 'load'
  | 'reloadFromDisk'
  | 'dismissExternalChange'
  | 'handleExternalCarFileChange'
  | 'startFromExampleCar'
  | 'updateCatalogListing'
  | 'setSearchQuery'
  | 'selectInstance'
  | 'selectCatalogPart'
  | 'setCarName'
  | 'setCarWifi'
  | 'addPart'
  | 'removePart'
  | 'renameInstance'
  | 'assignPin'
  | 'setI2cAddress'
  | 'setPlacement'
  | 'focusIssueRow'
  | 'setNewPartOpen'
  | 'saveCar'
  | 'createCustomPart'
> {
  const car = structuredClone(UNLOADED_CAR);
  return {
    api: null,
    car,
    partRowKeys: buildRowKeys(car),
    listing: DEFAULT_LISTING,
    catalog: initialCatalog,
    issues: [],
    loaded: false,
    dirty: false,
    saving: false,
    lastSavedCarJson: null,
    externalChange: false,
    saveStatus: null,
    loadError: null,
    loadErrorRaw: null,
    searchQuery: '',
    selectedInstanceId: null,
    selectedPartId: null,
    focusedRowKey: null,
    newPartOpen: false,
  };
}

export const useWorkbenchStore = create<WorkbenchState>()((set, get) => ({
  ...createInitialState(),

  async load(explicitApi, options) {
    let api: RcsimApi;
    try {
      api = resolveRcsimApi(explicitApi ?? get().api ?? undefined);
    } catch {
      set({
        api: null,
        loaded: false,
        loadError: 'rcsim API unavailable',
        loadErrorRaw: null,
      });
      return;
    }

    const current = get();
    // Preserve unsaved edits across environment tab switches unless reload is forced.
    if (!options?.force && current.loaded && current.dirty && current.api === api) {
      return;
    }

    set({ api });
    try {
      const [listing, carResult] = await Promise.all([api.catalog.list(), api.project.readCar()]);
      const catalog = catalogFromListing(listing);
      if (carResult.ok) {
        const car = carResult.car;
        const issues = checkWiring(car, catalog);
        const allIds = new Set([
          car.controller.instanceId,
          car.chassis.instanceId,
          ...car.parts.map((p) => p.instanceId),
        ]);
        const prevSelected = get().selectedInstanceId;
        const nextSelected =
          prevSelected && allIds.has(prevSelected) ? prevSelected : car.controller.instanceId;
        const selectedPart = [car.controller, car.chassis, ...car.parts].find(
          (p) => p.instanceId === nextSelected,
        );
        set({
          api,
          listing,
          catalog,
          car,
          partRowKeys: buildRowKeys(car, get().partRowKeys),
          issues,
          loaded: true,
          dirty: false,
          lastSavedCarJson: `${JSON.stringify(car, null, 2)}\n`,
          externalChange: false,
          loadError: null,
          loadErrorRaw: null,
          selectedInstanceId: nextSelected,
          selectedPartId: selectedPart?.partId ?? car.controller.partId,
        });
      } else {
        set({
          api,
          listing,
          catalog,
          loaded: false,
          dirty: false,
          externalChange: false,
          loadError: carResult.error,
          loadErrorRaw: carResult.raw,
        });
      }
    } catch (error) {
      const parsed = parseIpcError(error);
      set({
        api,
        loaded: false,
        dirty: false,
        externalChange: false,
        loadError: parsed.message,
        loadErrorRaw: null,
      });
    }
  },

  async reloadFromDisk() {
    await get().load(get().api ?? undefined, { force: true });
  },

  dismissExternalChange() {
    set({ externalChange: false });
  },

  async handleExternalCarFileChange() {
    const { api, saving, lastSavedCarJson, dirty } = get();
    if (!api || saving) return;
    try {
      const raw = await api.project.readFile('car.json');
      if (lastSavedCarJson !== null && raw === lastSavedCarJson) {
        // Ignore the file-watcher echo of our own writeCar call.
        return;
      }
    } catch {
      // If readFile fails, fall through to dirty check / reload.
    }
    if (dirty) {
      set({ externalChange: true });
      return;
    }
    await get().load(api, { force: true });
  },

  startFromExampleCar() {
    const { catalog } = get();
    const car = structuredClone(exampleCar);
    set({
      car,
      partRowKeys: buildRowKeys(car),
      issues: checkWiring(car, catalog),
      loaded: true,
      dirty: true,
      externalChange: false,
      loadError: null,
      loadErrorRaw: null,
      saveStatus: null,
      selectedInstanceId: car.controller.instanceId,
      selectedPartId: car.controller.partId,
    });
  },

  updateCatalogListing(listing) {
    const nextCatalog = catalogFromListing(listing);
    const { car, loaded } = get();
    set({
      listing,
      catalog: nextCatalog,
      issues: loaded ? checkWiring(car, nextCatalog) : get().issues,
    });
  },

  setSearchQuery(searchQuery) {
    set({ searchQuery });
  },

  selectInstance(instanceId) {
    const { car } = get();
    const all = [car.controller, car.chassis, ...car.parts];
    const found = all.find((p) => p.instanceId === instanceId);
    set({
      selectedInstanceId: instanceId,
      selectedPartId: found ? found.partId : get().selectedPartId,
    });
  },

  selectCatalogPart(partId) {
    set({
      selectedInstanceId: null,
      selectedPartId: partId,
    });
  },

  setCarName(name) {
    const { car, catalog } = get();
    const nextCar: Car = { ...car, name };
    set(updateCarState(nextCar, catalog));
  },

  setCarWifi(wifi) {
    const { car, catalog } = get();
    const nextCar: Car = { ...car, wifi };
    set(updateCarState(nextCar, catalog));
  },

  addPart(partId, requestedInstanceId) {
    const { car, catalog, partRowKeys } = get();
    const definition = catalog.get(partId);
    if (!definition) {
      return { ok: false, error: `Unknown part definition "${partId}".` };
    }

    // Exactly one controller and one chassis: choosing one replaces the current controller or chassis definition.
    if (definition.category === 'controller') {
      const nextController: Part = {
        ...car.controller,
        partId: definition.id,
      };
      const nextCar: Car = { ...car, controller: nextController };
      set(
        updateCarState(nextCar, catalog, {
          selectedInstanceId: nextController.instanceId,
          selectedPartId: definition.id,
        }),
      );
      return { ok: true, instanceId: nextController.instanceId };
    }

    if (definition.category === 'chassis') {
      const nextChassis = {
        ...car.chassis,
        partId: definition.id,
      };
      const nextCar: Car = { ...car, chassis: nextChassis };
      set(
        updateCarState(nextCar, catalog, {
          selectedInstanceId: nextChassis.instanceId,
          selectedPartId: definition.id,
        }),
      );
      return { ok: true, instanceId: nextChassis.instanceId };
    }

    let instanceId: string;
    if (requestedInstanceId !== undefined && requestedInstanceId.trim() !== '') {
      const trimmed = requestedInstanceId.trim();
      const parsed = InstanceId.safeParse(trimmed);
      if (!parsed.success) {
        return {
          ok: false,
          error: parsed.error.issues[0]?.message ?? 'Invalid instance id.',
        };
      }
      const existingIds = new Set([
        car.controller.instanceId,
        car.chassis.instanceId,
        ...car.parts.map((p) => p.instanceId),
      ]);
      if (existingIds.has(trimmed)) {
        return {
          ok: false,
          error: `Instance id "${trimmed}" is already used.`,
        };
      }
      instanceId = trimmed;
    } else {
      instanceId = uniqueInstanceId(car, partId);
    }

    const chassisDef = catalog.get(car.chassis.partId);
    const firstMount =
      chassisDef?.category === 'chassis' ? chassisDef.mountPoints[0]?.id : 'front-centre';
    const needsPlacement =
      'behavior' in definition &&
      (definition.behavior.template === 'distance-raycast' ||
        definition.behavior.template === 'imu');

    const newPart: Part = {
      instanceId,
      partId: definition.id,
      ...(needsPlacement && firstMount ? { placement: { mount: firstMount } } : {}),
    };

    const nextCar: Car = {
      ...car,
      parts: [...car.parts, newPart],
    };

    set(
      updateCarState(nextCar, catalog, {
        partRowKeys: {
          ...partRowKeys,
          [instanceId]: `part-row-${nextRowKeyCounter++}`,
        },
        selectedInstanceId: instanceId,
        selectedPartId: definition.id,
      }),
    );
    return { ok: true, instanceId };
  },

  removePart(instanceId) {
    const { car, catalog, selectedInstanceId, partRowKeys } = get();
    // Controller and chassis cannot be removed (exactly one of each).
    if (instanceId === car.controller.instanceId || instanceId === car.chassis.instanceId) {
      return;
    }

    const cleanDanglingPins = (part: Part): Part => {
      if (!part.pins) return part;
      const nextPins: Record<string, PinTarget> = {};
      for (const [pinName, target] of Object.entries(part.pins)) {
        if ('part' in target && target.part === instanceId) continue;
        nextPins[pinName] = target;
      }
      const { pins: _old, ...rest } = part;
      return Object.keys(nextPins).length > 0 ? { ...rest, pins: nextPins } : rest;
    };

    const nextParts = car.parts.filter((p) => p.instanceId !== instanceId).map(cleanDanglingPins);
    const nextController = cleanDanglingPins(car.controller);
    const nextCar: Car = { ...car, controller: nextController, parts: nextParts };
    const nextSelected =
      selectedInstanceId === instanceId ? car.controller.instanceId : selectedInstanceId;
    const { [instanceId]: _removedKey, ...remainingRowKeys } = partRowKeys;
    set(
      updateCarState(nextCar, catalog, {
        partRowKeys: remainingRowKeys,
        selectedInstanceId: nextSelected,
      }),
    );
  },

  renameInstance(oldId, newId) {
    const trimmed = newId.trim();
    if (trimmed === oldId) return { ok: true };
    const parsed = InstanceId.safeParse(trimmed);
    if (!parsed.success) {
      return {
        ok: false,
        error: parsed.error.issues[0]?.message ?? 'Invalid instance id.',
      };
    }
    const { car, catalog, selectedInstanceId, partRowKeys } = get();
    const allIds = [
      car.controller.instanceId,
      car.chassis.instanceId,
      ...car.parts.map((p) => p.instanceId),
    ];
    if (!allIds.includes(oldId)) {
      return { ok: false, error: `Unknown part "${oldId}".` };
    }
    if (allIds.includes(trimmed)) {
      return { ok: false, error: `Instance id "${trimmed}" is already used.` };
    }

    const rewritePins = (pins: Part['pins']): Part['pins'] => {
      if (!pins) return undefined;
      const updated: Record<string, PinTarget> = {};
      for (const [pinName, target] of Object.entries(pins)) {
        if ('part' in target && target.part === oldId) {
          updated[pinName] = { part: trimmed, pin: target.pin };
        } else {
          updated[pinName] = target;
        }
      }
      return updated;
    };

    const nextController: Part = {
      ...car.controller,
      instanceId: car.controller.instanceId === oldId ? trimmed : car.controller.instanceId,
      pins: rewritePins(car.controller.pins),
    };
    const nextChassis = {
      ...car.chassis,
      instanceId: car.chassis.instanceId === oldId ? trimmed : car.chassis.instanceId,
    };
    const nextParts: Part[] = car.parts.map((part) => ({
      ...part,
      instanceId: part.instanceId === oldId ? trimmed : part.instanceId,
      pins: rewritePins(part.pins),
    }));

    const nextCar: Car = {
      ...car,
      controller: nextController,
      chassis: nextChassis,
      parts: nextParts,
    };

    const preservedKey = partRowKeys[oldId] ?? `part-row-${nextRowKeyCounter++}`;
    const { [oldId]: _oldKey, ...restRowKeys } = partRowKeys;

    set(
      updateCarState(nextCar, catalog, {
        partRowKeys: {
          ...restRowKeys,
          [trimmed]: preservedKey,
        },
        selectedInstanceId: selectedInstanceId === oldId ? trimmed : selectedInstanceId,
      }),
    );
    return { ok: true };
  },

  assignPin(instanceId, pinName, target) {
    const { car, catalog } = get();
    const updatePartPins = (part: Part): Part => {
      if (part.instanceId !== instanceId) return part;
      const nextPins = { ...(part.pins ?? {}) };
      if (target === undefined) {
        delete nextPins[pinName];
      } else {
        nextPins[pinName] = target;
      }
      const { pins: _old, ...rest } = part;
      return Object.keys(nextPins).length > 0 ? { ...rest, pins: nextPins } : rest;
    };

    const nextCar: Car = {
      ...car,
      controller: updatePartPins(car.controller),
      parts: car.parts.map(updatePartPins),
    };
    set(updateCarState(nextCar, catalog));
  },

  setI2cAddress(instanceId, address) {
    const { car, catalog } = get();
    const updatePart = (part: Part): Part => {
      if (part.instanceId !== instanceId) return part;
      const { i2cAddress: _old, ...rest } = part;
      return address === undefined ? rest : { ...rest, i2cAddress: address };
    };
    const nextCar: Car = {
      ...car,
      controller: updatePart(car.controller),
      parts: car.parts.map(updatePart),
    };
    set(updateCarState(nextCar, catalog));
  },

  setPlacement(instanceId, placement) {
    const { car, catalog } = get();
    const updatePart = (part: Part): Part => {
      if (part.instanceId !== instanceId) return part;
      const { placement: _old, ...rest } = part;
      return placement === undefined ? rest : { ...rest, placement };
    };
    const nextCar: Car = {
      ...car,
      controller: updatePart(car.controller),
      parts: car.parts.map(updatePart),
    };
    set(updateCarState(nextCar, catalog));
  },

  focusIssueRow(focusedRowKey) {
    set({ focusedRowKey });
  },

  setNewPartOpen(newPartOpen) {
    set({ newPartOpen });
  },

  async saveCar() {
    const { car, catalog, loaded, loadError } = get();
    if (!loaded || loadError !== null) {
      return false;
    }

    let api: RcsimApi;
    try {
      api = resolveRcsimApi(get().api ?? undefined);
    } catch {
      set({
        saveStatus: {
          ok: false,
          flaggedErrors: 0,
          message: 'rcsim API unavailable',
        },
      });
      return false;
    }

    const parsed = Car.safeParse(car);
    if (!parsed.success) {
      const readableError = parsed.error.issues
        .map((i) => `${i.path.length > 0 ? `${i.path.join('.')}: ` : ''}${i.message}`)
        .join('; ');
      set({
        saveStatus: {
          ok: false,
          flaggedErrors: 0,
          message: readableError || 'Invalid car configuration.',
        },
      });
      return false;
    }

    const serialized = `${JSON.stringify(parsed.data, null, 2)}\n`;
    set({ saving: true, saveStatus: null, lastSavedCarJson: serialized });
    try {
      const issues = checkWiring(parsed.data, catalog);
      const errorCount = issues.filter((i) => i.severity === 'error').length;
      await api.project.writeCar(parsed.data);
      const message = canRun(issues)
        ? 'Saved car.json and regenerated include/car_config.h.'
        : `Saved car.json and include/car_config.h with ${errorCount} wiring error(s) (flagged: Run in Sim is blocked until resolved).`;
      set({
        saving: false,
        dirty: false,
        externalChange: false,
        issues,
        saveStatus: {
          ok: true,
          flaggedErrors: errorCount,
          message,
        },
      });
      return true;
    } catch (error) {
      const ipcErr = parseIpcError(error);
      set({
        saving: false,
        saveStatus: {
          ok: false,
          flaggedErrors: 0,
          message: ipcErr.message,
        },
      });
      return false;
    }
  },

  async createCustomPart(definition) {
    let api: RcsimApi;
    try {
      api = resolveRcsimApi(get().api ?? undefined);
    } catch {
      return { ok: false, error: 'rcsim API unavailable' };
    }

    const parsed = PartDefinition.safeParse(definition);
    if (!parsed.success) {
      return {
        ok: false,
        error: parsed.error.issues
          .map((i) => `${i.path.length > 0 ? `${i.path.join('.')}: ` : ''}${i.message}`)
          .join('; '),
      };
    }

    if (defaultCatalog.has(parsed.data.id) || get().catalog.has(parsed.data.id)) {
      return {
        ok: false,
        error: `part id "${parsed.data.id}" is already in the catalog`,
      };
    }

    try {
      const { path } = await api.catalog.saveCustomPart(parsed.data);
      const listing = await api.catalog.list();
      const catalog = catalogFromListing(listing);
      const { car } = get();
      set({
        listing,
        catalog,
        issues: checkWiring(car, catalog),
        selectedPartId: parsed.data.id,
        selectedInstanceId: null,
        newPartOpen: false,
      });
      return { ok: true, path };
    } catch (error) {
      const ipcErr = parseIpcError(error);
      return { ok: false, error: ipcErr.message };
    }
  },
}));

/** Resets the Workbench store to its initial unloaded state (for tests). */
export function resetWorkbenchStore(): void {
  useWorkbenchStore.setState(createInitialState());
}

/** Helper returning all parts of the car that have pins (controller + car.parts). */
export function partsWithPins(car: Car): readonly Part[] {
  return carParts(car);
}
