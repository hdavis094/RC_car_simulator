# P2-01 — Integration and the v1 demo

Status: todo
Agent: Claude (Opus)
Branch: ws/p2-01
Depends on: all of Phase 1
Gate: the user reviews the demo before Phase 3

## Goal

The whole v1 acceptance demo (PRD) works in the app, and the v1 scenario passes headless in `pnpm verify`.

## Owned paths

`apps/desktop/src/main/services/{sim,control,world-edit}/`, `e2e/`, `scenarios/`, plus minimal wiring edits anywhere else. Every edit outside the owned paths is listed in the Handoff with the reason.

## Read first

Everything in `docs/`; the Handoff sections of every Phase 1 brief.

## Requirements

1. **SimService** (main process):
   - on Run: check wiring (block on errors), regenerate the header, build-sim, then start a sim-core `Run` with the firmware bridge in a `utilityProcess`
   - stream snapshots to the renderer
   - pace to the chosen speed
   - serial RX/TX
   - net mappings
   - world-edit applied live while paused
2. **ControlService**: `ControlClient` from `control-protocol`, auto-connecting to the car's mapped port when a run starts. It can be pointed at any host:port, i.e. a real car.
3. **The v1 scenario** in `scenarios/v1.json`:
   - starter firmware, the oval with the fixed cone layout `scenarios/worlds/v1-cones.json`, seed 1, 60 s
   - control timeline: `mode auto` at t = 3 s, after ESC arming
   - assertions: no collisions, laps ≥ 1
   - replaces the placeholder in `pnpm verify`
   - retune the starter firmware constants if needed, and record the changes
4. **Playwright demo test**:
   - new project → Workbench shows zero errors → Terminal Build succeeds
   - 3D World: place a cone → Run → Serial Monitor shows the boot banner → Network Console shows telemetry
   - switch to manual → keyboard drive moves the car → stop
5. **`docs/DEMO.md`**: a manual demo checklist for the user, including gamepad driving and connecting an external client (`nc 127.0.0.1 <port>`) to the car.

## Acceptance

- [ ] `pnpm verify` passes, including the v1 scenario and the Playwright demo test
- [ ] the v1 scenario passes 10 times in a row with seeds 1–10 (seed 1 is the gate; report the others)
- [ ] the user has walked through `docs/DEMO.md` and approved it

## Out of scope

Phase 3 items.

## Handoff

- **Built**:
- **Edits outside owned paths**:
- **Deviations from the brief**:
- **Open questions**:
