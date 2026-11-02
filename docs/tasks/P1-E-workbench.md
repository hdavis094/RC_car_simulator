# P1-E — app: Workbench environment

Status: in-review
Agent: Antigravity
Branch: ws/p1-e
Depends on: P0 (all)
Wave: 1

## Goal

In the Workbench the user designs the car. They pick parts, assign pins with live wiring rules, place sensors on mount points with a 3D beam preview, and create custom parts. Saving writes `car.json` and the car config header.

## Owned paths

`apps/desktop/src/renderer/workbench/`

## Read first

`apps/desktop/src/shared/ipc.ts` (project, catalog), `packages/schema` (all of it, especially `checkWiring` and `generateCarConfigHeader`), PRD → Workbench, `GLOSSARY.md`.

## Requirements

1. **Parts panel**: the catalog grouped by category, with search. Add a part to the car with an instance id (C-identifier-safe, unique, editable); remove a part. Exactly one controller and one chassis.
2. **Pin assignment table**:
   - one row per part pin
   - a GPIO dropdown that shows each pin's capabilities (ADC1, input-only, strapping…)
   - power pins connect to a power source part
   - **wiring rule issues** shown inline on the row and in a summary list: errors red, warnings amber
   - clicking an issue focuses its row
3. **Placement**:
   - a mount-point picker per sensor and actuator
   - numeric offset (mm) and yaw/pitch (deg)
   - a three.js / react-three-fiber preview: chassis box at the defined dimensions, part boxes at their placements, distance-sensor beams drawn as cones from the behavior params (range, beam angle)
4. **Part inspector**: the selected part's definition (electrical values, behavior params, datasheet links).
5. **New Part form**: every part-definition field, the behavior template chosen from a list with a params form generated from the schema, validated with the Zod schema. It saves to the project's `parts/` through the catalog IPC; the new part appears in the parts panel.
6. **Save**: writes `car.json` and regenerates `include/car_config.h`. Saving with wiring errors is allowed but flagged. Run is blocked elsewhere on errors.
7. Workbench state lives in a Zustand store inside the owned folder; all I/O goes through `ipc.ts`.

## Acceptance

- [x] `pnpm verify` passes
- [x] component tests (Vitest + Testing Library, fake IPC from the `shared/` stubs):
  - [x] loading the example car from `packages/schema` shows zero errors
  - [x] assigning two parts to the same GPIO shows the conflict on both rows
  - [x] moving the battery divider to an ADC2 pin shows the Wi-Fi/ADC2 error
  - [x] a custom part created in the form round-trips through save and reload
- [x] saving writes a header byte-identical to `generateCarConfigHeader` for the same car

## Out of scope

Main-process services (P1-D), the world viewer (P1-F), visual wiring diagrams, drag-to-place gizmos.

## Handoff

- **Built**:
  - **Zustand store (`workbench-store.ts`)**: holds the active `Car`, `CatalogListing`, resolved `Catalog`, live `checkWiring` `Issue[]`, selection state, stable row keys (`partRowKeys`), focused row key, `loaded` / `loadError` / `loadErrorRaw` / `externalChange` flags, and dirty/save status. All project and catalog I/O flows through `ipc.ts` (`project.readCar`, `project.writeCar`, `project.onFileChange`, `catalog.list`, `catalog.saveCustomPart`, `catalog.onChange`); `resolveRcsimApi` uses the explicit `api` prop else `window.rcsim` else throws `'rcsim API unavailable'`.
  - **Parts panel (`PartsPanel.tsx`)**: displays the catalog grouped by `PART_CATEGORIES` with search filtering, custom part badges, and catalog file problem alerts. Supports adding parts with C-identifier-safe unique instance IDs, inline editing/renaming of instance IDs committed on blur or Enter with stable React row keys (rewriting any part-to-part pin references), and removing parts (cleaning up any dangling `{part, pin}` references) while enforcing exactly one controller and one chassis.
  - **Pin assignment table (`PinAssignmentTable.tsx`)**: renders one row per part pin across `carParts(car)`, with a controller GPIO dropdown showing each pin's capabilities (`ADC1`, `ADC2`, `input-only`, `strapping`, `flash`, `UART0 TX/RX`, `touch`, label), a power-source selector for `power-in` pins, clearable I²C address input (`NumericInput`) for I²C parts, inline error/warning display per row, and a clickable wiring issues summary list that focuses and scrolls to the corresponding row.
  - **Placement & 3D preview (`PlacementPanel.tsx`, `CarPreview3D.tsx`, `NumericInput.tsx`)**: mount-point picker and draft-backed numeric `offsetMm` (`x`, `y`, `z`) + `yawDeg` / `pitchDeg` inputs for sensors and actuators, paired with a Three.js / `@react-three/fiber` preview (`CarPreviewScene`, `buildPreviewSceneData`, `<Canvas frameloop="demand">`, and module-memoized WebGL support probe) rendering the chassis box at its defined dimensions, placed part boxes, and distance-sensor beam cones computed from `maxRangeMm` and `beamAngleDeg`.
  - **Part inspector (`PartInspector.tsx`)**: displays physical dimensions and mass, electrical values (`supplyV`, `logicLevelV`, `currentMa`, `gpioMaxInputV`), I²C bus addressing, chassis geometry, behavior template parameters, and datasheet `sources` links (`http:`/`https:` rendered as clickable links, other schemes as plain text) and `notes`.
  - **New Part form (`NewPartForm.tsx`)**: covers every `PartDefinition` field across all categories (including all `GpioDefinition` fields `gpio`, `label`, `inputOnly`, `adc1Channel`, `adc2Channel`, `touchChannel`, `strapping`, `flash`, `uart0`; chassis `centreOfGravityMm` `x`/`y`/`z` and full `mountPoints` `id`, `positionMm`, `yawDeg`, `pitchDeg` with add/remove; and pin `voltage` modes `none` / `number` / `supply` / `{min,max}` range, `maxInputV`, `maxCurrentMa`, `description`, `optional`), dynamically generates the behavior parameter inputs by introspecting `@rcsim/schema`'s `Behavior` Zod discriminated union (`describeBehaviorParamsSchema`), validates with `PartDefinition.safeParse`, rejects custom part IDs that shadow built-in or existing catalog parts, and resets after saving to `parts/<id>.json` via `catalog.saveCustomPart`.
  - **Save & header generation (`WorkbenchRoot.tsx`)**: saves `car.json` and regenerates `include/car_config.h` via `project.writeCar`, disables Save until a valid car is loaded, offers an explicit "Start from the example car" recovery action (and raw JSON display) on load failure, shows a "Reload from disk" / "Keep mine" banner on external `car.json` changes while dirty, and provides a collapsible `include/car_config.h` preview.
  - **Component tests (`WorkbenchRoot.test.tsx`)**: Vitest + Testing Library + `user-event` + `jsdom` suite covering all acceptance and edge-case scenarios against `createFakeRcsimApi()` with `resetWorkbenchStore()` in `beforeEach`.
- **Review round 1**:
  1. **Removed silent fallback to `createFakeRcsimApi()`**: deleted the fake import from `workbench-store.ts`; `resolveRcsimApi` returns the explicit `api` prop, else `window.rcsim` (when preload services are present), else throws `'rcsim API unavailable'`. `load` catches that and sets `loadError: 'rcsim API unavailable'` and `loaded: false`; `saveCar` refuses to run.
  2. **Preserved unsaved edits across remounts, external changes, and own saves**: `load` returns early when `loaded && dirty` unless forced (`reloadFromDisk`). `handleExternalCarFileChange` ignores watcher events whose disk content matches `lastSavedCarJson`, sets `externalChange: true` (rendering the "Reload from disk" / "Keep mine" banner) when `dirty`, and reloads silently only when clean.
  3. **Prevented overwriting broken `car.json` with `exampleCar`**: when `readCar` returns `{ ok: false, raw, error }` or rejects, `loaded` stays `false`, `loadError` and `loadErrorRaw` are populated, Save is disabled, and `saveCar` returns early. Added an explicit "Start from the example car" recovery button (`startFromExampleCar`) and displayed `raw`.
  4. **Completed all `PartDefinition` fields in `NewPartForm.tsx`**: added inputs for all controller GPIO fields (`label`, `inputOnly`, `adc1Channel`, `adc2Channel`, `touchChannel`, `strapping`, `flash`, `uart0`), chassis `centreOfGravityMm` (`x`, `y`, `z`) and mount-point `positionMm` (`x`, `y`, `z`), `yawDeg`, `pitchDeg` plus add/remove buttons, and pin `voltage` modes (`none`, fixed `number`, `supply`, `{min,max}` `range`), `maxInputV`, and `description`. Updated the Handoff notes accordingly.
  5. **Fixed instance ID editing in `PartsPanel.tsx`**: `InstanceIdEditor` now keeps local draft state and commits only on `onBlur` or `Enter` (reverting on `Escape`), and part rows are keyed by stable IDs (`partRowKeys`) preserved across `renameInstance`. Tested with `@testing-library/user-event` character-by-character typing.
  6. **Strengthened tests in `WorkbenchRoot.test.tsx`**: added `resetWorkbenchStore()` in `beforeEach`, verified `car.json` contents on `fake.files`, reset the singleton store before remounting in the custom-part round-trip test, and added tests for reference rewriting on rename, dangling reference cleanup on remove, save failure, dirty store across unmount/remount, dirty store during external `car.json` changes, refusing to save after a failed load, and full New Part form coverage.
  7. **Fixed number inputs (`NumericInput.tsx`)**: added a string-draft-backed `NumericInput` component used across `PlacementPanel.tsx`, `PinAssignmentTable.tsx`, and `NewPartForm.tsx` so typing `-` / negative numbers and clearing optional fields (such as I²C address) work naturally without snapping to `0`.
  8. **Memoized `canUseWebGL()` and released the probe context**: cached WebGL detection at module level in `CarPreview3D.tsx` and called `gl.getExtension('WEBGL_lose_context')?.loseContext()` immediately after probing.
  9. **Render on demand**: added `frameloop="demand"` to `<Canvas>` in `CarPreview3D.tsx`.
  10. **Blocked custom part IDs from shadowing built-ins and reset form on save**: `createCustomPart` rejects IDs already present in `defaultCatalog` or `catalog`, `catalogFromListing` skips colliding custom IDs, and `NewPartForm` resets to default values after a successful save.
  11. **Recomputed wiring issues on `catalog.onChange`**: `updateCatalogListing` updates `listing`, `catalog`, and `issues: checkWiring(car, nextCatalog)`.
  12. **Restricted datasheet links to `http:` and `https:`**: `PartInspector.tsx` validates each URL with `new URL(url)` and renders non-HTTP(S) schemes (`javascript:`, `file:`, etc.) as plain `<span>` text.
  13. **Small cleanups**: updated IMU default pins to `VCC`/`SDA`/`SCL`/`GND`, formatted `Car.safeParse` failures into readable messages on save, deduplicated `formatHex`, and cleaned up dangling `{part, pin}` references when removing a part.
  - **Declined items**: none (all 13 findings addressed).
- **Deviations from the brief**:
  - Added `three`, `@react-three/fiber`, `@types/three`, `@testing-library/react`, `@testing-library/dom`, `@testing-library/user-event`, and `jsdom` to `apps/desktop/package.json` (and updated `pnpm-lock.yaml`) as permitted by `AGENTS.md` ("If you need a dependency, add it to your own package's `package.json`"), and used `// @vitest-environment jsdom` in `WorkbenchRoot.test.tsx` so `apps/desktop/vitest.config.mts` remained untouched.
- **Contract change requests**: none.
- **Open questions**: none.
