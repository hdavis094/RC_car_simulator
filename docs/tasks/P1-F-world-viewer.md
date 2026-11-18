# P1-F — app: 3D World environment

Status: in-review
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

- [x] `pnpm verify` passes
- [x] component tests, fed from a real `sim-core` `Run` with a scripted `ActuatorSource` (running in the test, not the renderer):
  - [x] the car mesh pose matches snapshot poses
  - [x] a placed cone appears in the next world-edit save payload with the right position and yaw
- [x] keyboard input while in manual produces `drive` commands with the expected throttle and steer signs, sent through a fake control IPC
- [x] a Playwright screenshot of the oval with three cones is attached to the Handoff

## Out of scope

Run wiring in the main process (P2-01), track editing, the camera sensor, network fault injection UI (Phase 3).

## Handoff

- **Built**:
  - `apps/desktop/src/renderer/world/track-mesh.ts`: centripetal Catmull-Rom & polyline track sampling, track surface ribbon `BufferGeometry`, inner/outer wall segments, start/finish line geometry, and built-in fallback `oval` and `technical` track data when `main`'s P1-D `worldEdit.loadTrack` stub returns `not-implemented`.
  - `apps/desktop/src/renderer/world/interpolation.ts`: `lerpVec3`, `slerpQuat`, `interpolateSnapshots`, and `SnapshotInterpolator` for smooth 60 Hz display between the last two `StateSnapshot`s.
  - `apps/desktop/src/renderer/world/scene-data.ts`: scene data builder (`buildWorldSceneData`), camera transforms (`follow`, `orbit`, `top-down`), ground plane raycasting (`screenToGroundPoint`), and Three.js scene graph synchronization (`syncThreeSceneGraph` for `car-body`, `wheel:front-left`..`wheel:rear-right`, `track-surface`, `track-walls`, `track-start-finish`, `obstacle:<id>`, `sensor-beam:<id>:<i>`, `beam-hit:<id>:<i>`).
  - `apps/desktop/src/renderer/world/driving-controller.ts`: 50 Hz (`20 ms`) keyboard (`WASD`/arrow keys) and Gamepad API (`navigator.getGamepads()`) input sampling, `Space` E-stop detection, and editable target filtering.
  - `apps/desktop/src/renderer/world/NetworkConsole.tsx`: control-protocol JSON-lines console with live telemetry strip (`mode`, `throttle`, `steer`, `ToF` distances, `battery`), pretty-printed incoming JSON messages, and raw line sender via `api.control.sendRaw`.
  - `apps/desktop/src/renderer/world/WorldScene.tsx`: `@react-three/fiber` `<Canvas>` 3D scene with `useFrame` 60 Hz snapshot interpolation, track/car/wheels/obstacles/sensor-beams rendering, SVG fallback for headless jsdom tests, and interactive ground/obstacle/rotation-handle pointer layer.
  - `apps/desktop/src/renderer/world/WorldRoot.tsx`: full 3D World environment integrating run controls, driving controls (ADR 0004 control IPC), obstacle palette & layout save/load (`worlds/*.json`), camera selector, and shared bottom dock integration (reusing `BottomPanel` or portaling the `Network Console` tab into `App`'s outer `BottomPanel` when hosted inside `App`).
  - `apps/desktop/src/renderer/world/WorldRoot.test.tsx`: component tests fed from a real `sim-core` `Run` with a scripted `ActuatorSource`, obstacle placement/rotation/save payload verification, 50 Hz manual driving & E-stop control IPC tests, and sensor beam & Network Console tests.
  - `apps/desktop/src/renderer/world/world.playwright.ts` & `apps/desktop/src/renderer/world/oval-three-cones.png`: Playwright e2e test and screenshot of the oval track with three cones (`![Oval track with three cones](../../apps/desktop/src/renderer/world/oval-three-cones.png)`).
- **Deviations from the brief**:
  - When hosted inside `App` with an open project (`App.tsx` renders `<BottomPanel />` without passing `tabs` from `WorldRoot`), `WorldRoot` portals the `Network Console` tab and panel into `App`'s shared `BottomPanel` so there is a single `[aria-label="Shared bottom panel"]` across the shell; when rendered standalone in component tests, `WorldRoot` mounts `BottomPanel` directly with `createWorldDockTabs()`.
  - While `main`'s `worldEdit` handlers are P1-A `not-implemented` stubs (until P1-D/P2-01 merge), `WorldRoot` falls back to built-in track definitions for `oval`/`technical` and `api.project.writeFile`/`readFile` for `worlds/*.json` when `worldEdit` rejects with `not-implemented`.
- **Contract change requests**:
  - None.
- **Open questions**:
  - None.
