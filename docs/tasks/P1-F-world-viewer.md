# P1-F — app: 3D World environment

Status: todo
Agent: Antigravity
Branch: ws/p1-f
Depends on: P1-A
Wave: 2

## Goal

The 3D World shows a run as it happens, lets the user lay out obstacles, and hosts the driving controls and consoles. The renderer displays sim state; it never owns it.

## Owned paths

`apps/desktop/src/renderer/world/`

## Read first

`apps/desktop/src/shared/ipc.ts` (run, world-edit, control), `packages/sim-core/src/api/` (`StateSnapshot`), track data via `worldEdit.listTracks`/`loadTrack` (P1-A's `assets/tracks/`), PRD → 3D World, ADR 0004.

## Requirements

1. **Scene** (react-three-fiber):
   - track mesh generated from track data (surface, walls, start/finish line)
   - car body and four wheels posed from `StateSnapshot`
   - sensor beams drawn per reading (hit point marked)
   - follow, orbit and top-down cameras
   - smooth display at 60 Hz from snapshots that may arrive at a different rate (interpolate between the last two)
2. **Obstacle editing** (only while the run is stopped or paused):
   - palette of cone, box, wall section and ramp
   - click the ground to place, drag to move, a handle or keys to rotate, delete
   - save or load layouts to `worlds/*.json` through world-edit IPC
3. **Run controls**: Run / Stop / Pause / Step, speed selector (0.25×–8×, unpaced), sim time display, seed field, lap counter and collision count.
4. **Driving**:
   - Manual/Auto toggle sends a `mode` command
   - keyboard (WASD/arrows) and the Gamepad API become `drive` commands at 50 Hz while manual
   - E-stop button and key (Space) sends `estop`
   - every command goes through the control IPC (ADR 0004)
5. **Bottom dock**: reuses the shell's dockable panel (P1-D) with tabs for Serial Monitor, Shell, Network Console. The Network Console is a raw JSON-lines view: send line, pretty-printed incoming messages, and a telemetry strip (mode, throttle, steer, ToF distances, battery).

## Acceptance

- [ ] `pnpm verify` passes
- [ ] component tests, fed from a real `sim-core` `Run` with a scripted `ActuatorSource` (running in the test, not the renderer):
  - [ ] the car mesh pose matches snapshot poses
  - [ ] a placed cone appears in the next world-edit save payload with the right position and yaw
- [ ] keyboard input while in manual produces `drive` commands with the expected throttle and steer signs, sent through a fake control IPC
- [ ] a Playwright screenshot of the oval with three cones is attached to the Handoff

## Out of scope

Run wiring in the main process (P2-01), track editing, the camera sensor, network fault injection UI (Phase 3).

## Handoff

- **Built**:
- **Deviations from the brief**:
- **Contract change requests**:
- **Open questions**:
