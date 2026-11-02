# P1-E — app: Workbench environment

Status: in-progress
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

- [ ] `pnpm verify` passes
- [ ] component tests (Vitest + Testing Library, fake IPC from the `shared/` stubs):
  - [ ] loading the example car from `packages/schema` shows zero errors
  - [ ] assigning two parts to the same GPIO shows the conflict on both rows
  - [ ] moving the battery divider to an ADC2 pin shows the Wi-Fi/ADC2 error
  - [ ] a custom part created in the form round-trips through save and reload
- [ ] saving writes a header byte-identical to `generateCarConfigHeader` for the same car

## Out of scope

Main-process services (P1-D), the world viewer (P1-F), visual wiring diagrams, drag-to-place gizmos.

## Handoff

- **Built**:
- **Deviations from the brief**:
- **Contract change requests**:
- **Open questions**:
