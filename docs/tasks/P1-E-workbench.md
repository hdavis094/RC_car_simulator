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
  - **Zustand store (`workbench-store.ts`)**: holds the active `Car`, `CatalogListing`, resolved `Catalog`, live `checkWiring` `Issue[]`, selection state, focused row key, and dirty/save status. All project and catalog I/O flows through `ipc.ts` (`project.readCar`, `project.writeCar`, `project.onFileChange`, `catalog.list`, `catalog.saveCustomPart`, `catalog.onChange`), falling back to `createFakeRcsimApi()` only when `window.rcsim.project` is not yet wired in the P0-02 preload stub.
  - **Parts panel (`PartsPanel.tsx`)**: displays the catalog grouped by `PART_CATEGORIES` with search filtering, custom part badges, and catalog file problem alerts. Supports adding parts with C-identifier-safe unique instance IDs, inline editing/renaming of instance IDs (rewriting any part-to-part pin references), and removing parts while enforcing exactly one controller and one chassis.
  - **Pin assignment table (`PinAssignmentTable.tsx`)**: renders one row per part pin across `carParts(car)`, with a controller GPIO dropdown showing each pin's capabilities (`ADC1`, `ADC2`, `input-only`, `strapping`, `flash`, `UART0 TX/RX`, `touch`, label), a power-source selector for `power-in` pins, I²C address input for I²C parts, inline error/warning display per row, and a clickable wiring issues summary list that focuses and scrolls to the corresponding row.
  - **Placement & 3D preview (`PlacementPanel.tsx`, `CarPreview3D.tsx`)**: mount-point picker and numeric `offsetMm` (`x`, `y`, `z`) + `yawDeg` / `pitchDeg` inputs for sensors and actuators, paired with a Three.js / `@react-three/fiber` preview (`CarPreviewScene` & `buildPreviewSceneData`) rendering the chassis box at its defined dimensions, placed part boxes, and distance-sensor beam cones computed from `maxRangeMm` and `beamAngleDeg`.
  - **Part inspector (`PartInspector.tsx`)**: displays physical dimensions and mass, electrical values (`supplyV`, `logicLevelV`, `currentMa`, `gpioMaxInputV`), I²C bus addressing, chassis geometry, behavior template parameters, and clickable datasheet `sources` links and `notes`.
  - **New Part form (`NewPartForm.tsx`)**: covers all `PartDefinition` fields across all categories, dynamically generates the behavior parameter inputs by introspecting `@rcsim/schema`'s `Behavior` Zod discriminated union (`describeBehaviorParamsSchema`), validates with `PartDefinition.safeParse`, and saves custom parts to `parts/<id>.json` via `catalog.saveCustomPart`.
  - **Save & header generation (`WorkbenchRoot.tsx`)**: saves `car.json` and regenerates `include/car_config.h` via `project.writeCar`, flagging saves when wiring errors are present and providing a collapsible `include/car_config.h` preview.
  - **Component tests (`WorkbenchRoot.test.tsx`)**: Vitest + Testing Library + `jsdom` suite covering all acceptance scenarios against `createFakeRcsimApi()`.
- **Deviations from the brief**:
  - Added `three`, `@react-three/fiber`, `@types/three`, `@testing-library/react`, `@testing-library/dom`, `@testing-library/user-event`, and `jsdom` to `apps/desktop/package.json` (and updated `pnpm-lock.yaml`) as permitted by `AGENTS.md` ("If you need a dependency, add it to your own package's `package.json`"), and used `// @vitest-environment jsdom` in `WorkbenchRoot.test.tsx` so `apps/desktop/vitest.config.mts` remained untouched.
- **Contract change requests**: none.
- **Open questions**: none.
