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
  - `apps/desktop/src/renderer/world/track-mesh.ts`: centripetal Catmull-Rom & polyline track sampling, memoized `generateTrackMeshData` per track ID, track surface ribbon `BufferGeometry`, inner/outer wall segments, start/finish line geometry, and built-in fallback `oval` and `technical` track data (`// TODO(P2-01): remove when worldEdit is wired`).
  - `apps/desktop/src/renderer/world/interpolation.ts`: `lerpVec3`, `slerpQuat`, `interpolateSnapshots` (interpolating car pose, wheels, sensor beams, and obstacles with the same `alpha`), and `SnapshotInterpolator` for smooth 60 Hz display between the last two `StateSnapshot`s.
  - `apps/desktop/src/renderer/world/scene-data.ts`: scene data builder (`buildWorldSceneData`), camera transforms (`follow`, `orbit`, `top-down`), ground plane raycasting (`screenToGroundPoint`), and viewport projection (`groundPointToViewportUV`) projecting through the live R3F camera and actual viewport aspect ratio.
  - `apps/desktop/src/renderer/world/driving-controller.ts`: 50 Hz (`20 ms`) keyboard (`WASD`/arrow keys) and Gamepad API (`navigator.getGamepads()`) input sampling, `Space` E-stop detection, and editable target filtering.
  - `apps/desktop/src/renderer/world/NetworkConsole.tsx`: control-protocol JSON-lines console with live telemetry strip (`mode`, `throttle`, `steer`, `ToF` distances, `battery`), pretty-printed incoming JSON messages, and raw line sender via `api.control.sendRaw`.
  - `apps/desktop/src/renderer/world/WorldScene.tsx`: `@react-three/fiber` `<Canvas>` 3D scene (`WorldR3FScene`) with `useFrame` 60 Hz snapshot interpolation, pooled in-place sensor beam `BufferGeometry` updates and disposal, track/car/wheels/obstacles rendering, user-facing `"WebGL unavailable"` fallback, and interactive pointer-captured ground/obstacle/rotation-handle overlay.
  - `apps/desktop/src/renderer/world/WorldRoot.tsx`: full 3D World environment integrating run controls, driving controls (ADR 0004 control IPC), obstacle palette & layout save/load (`worlds/*.json`), camera selector, and exported `createWorldDockTabs(api)` for `BottomPanel`.
  - `apps/desktop/src/renderer/world/WorldRoot.test.tsx`: component and `@react-three/test-renderer` tests fed from a real `sim-core` `Run` with a scripted `ActuatorSource`, geometry count / leak check across $N$ snapshots, obstacle placement/rotation/save payload verification, 50 Hz manual driving & E-stop control IPC tests, and sensor beam & Network Console tests.
  - `apps/desktop/src/renderer/world/world.playwright.ts` & `apps/desktop/src/renderer/world/oval-three-cones.png`: Playwright e2e test and screenshot of the oval track with three cones (`![Oval track with three cones](../../apps/desktop/src/renderer/world/oval-three-cones.png)`).
- **Review round 1**:
  1. **Window focus loss & modifier keys**: Added `blur` and `visibilitychange` (to `hidden`) listeners that clear held driving keys, send neutral (`drive({ throttle: 0, steer: 0 })`), call `control.releaseDrive()`, and stop sending. Ignored `keydown` events with `repeat`, `ctrlKey`, `metaKey`, or `altKey`.
  2. **Drive release on mode change, environment switch, and unmount**: Released active drive (neutral + `releaseDrive()`) whenever `driveMode` leaves `'manual'`, the active environment leaves `'world'`, or `WorldRoot` unmounts; also called `control.disconnect()` on `WorldRoot` unmount. Tested all three paths.
  3. **Paused move/rotate synchronous ref read & rAF throttling**: Read current obstacle `positionM` and `yawDeg` synchronously from `worldFileRef.current` before updating state or calling IPC; throttled paused drag IPC calls (`worldEdit.moveObstacle`) to at most one per `requestAnimationFrame` and flushed the final pose on `pointerup`.
  4. **Unique obstacle IDs after loading a layout**: Added `generateUniqueObstacleId(type, existingObstacles)` (taking max existing numeric suffix + 1 per obstacle kind) so loading `cone-1` and placing a cone produces `cone-2`.
  5. **Zero snapshot-rate React state re-renders & geometry pooling/disposal**: Removed snapshots from React `useState` (using `latestSnapshotRef`, `SnapshotInterpolator`, imperative readout DOM updates, and R3F `useFrame`), memoized `generateTrackMeshData` per track ID, pooled sensor beam `THREE.Line`/`BufferGeometry` instances with in-place `BufferAttribute.setXYZ` updates and disposal, and added a test verifying rendering 60 snapshots does not grow Three.js geometry count or recreate the track mesh.
  6. **Real R3F scene tests & Playwright verification**: Removed `getWorldThreeScene()`, `syncThreeSceneGraph`, and hidden `data-*` telemetry divs from production code; added `@react-three/test-renderer` to `apps/desktop` `devDependencies` and tested `WorldR3FScene` mesh world poses against a real `sim-core` `Run` across `useFrame` advances (including mid-frame interpolation); replaced the test SVG fallback with a user-facing `"WebGL unavailable"` fallback; updated `world.playwright.ts` to wait on `data-ready="true"`, dynamically project cone click positions from world coordinates, verify non-blank WebGL canvas pixels, and re-captured `oval-three-cones.png` without the local filesystem path.
  7. **Aspect-accurate pointer overlay**: Tracked viewport dimensions via `ResizeObserver` and projected `groundPointToViewportUV` and `screenToGroundPoint` through the live R3F camera and actual viewport aspect ratio; added a 16:9 (`1600×900`) alignment and inverse round-trip test.
  8. **Track & obstacle dimension drift guard**: Marked track fallbacks with `// TODO(P2-01): remove when worldEdit is wired` and added a test comparing `BUILTIN_OVAL_TRACK`, `BUILTIN_TECHNICAL_TRACK`, and `OBSTACLE_DIMENSIONS` against `packages/sim-core/assets/tracks/{oval,technical}.json` and sim-core's `OBSTACLE_SIZES`.
  9. **Save fallback validation & `normalizeLayoutPath` hardening**: Validated payloads with `World.parse` before writing in `handleSaveLayout`, and made `normalizeLayoutPath` reject `..`, backslashes, absolute paths, and anything outside `worlds/`.
  10. **Paused edit rollback**: Rolled back `worldFile` and `selectedObstacleId` when paused `addObstacle`, `moveObstacle`, or `removeObstacle` rejects with any error code other than `not-implemented`.
  11. **Sensor beam & obstacle interpolation**: Updated `interpolateSnapshots` to interpolate sensor beam origins, directions, and hit distances as well as obstacle poses with the same `alpha` as the car pose.
  12. **Pointer capture on drags**: Used `setPointerCapture` / `releasePointerCapture` (and `onPointerCancel` / `onLostPointerCapture`) on the interactive ground overlay so releasing outside the overlay ends the drag and flushes pending paused edits.
  13. **Control connect backoff**: Connected `api.control` when a run starts and backed off failed `control.connect` attempts while no run exists instead of retrying on every 50 Hz drive tick.
- **Deviations from the brief**:
  - While `main`'s `worldEdit` handlers are P1-A `not-implemented` stubs (until P2-01 wires them), `WorldRoot` falls back to built-in track definitions for `oval`/`technical` (`// TODO(P2-01): remove when worldEdit is wired`) and `api.project.writeFile`/`readFile` (after `World.parse` validation) for `worlds/*.json` when `worldEdit` rejects with `not-implemented`.
- **Contract change requests**:
  - **App shell / BottomPanel integration (`apps/desktop/src/renderer/shell/App.tsx`)**: All portals and DOM scraping (`document.querySelector('.app-shell')`, `isHostedInApp`) have been removed from `WorldRoot`. `apps/desktop/src/renderer/world/index.ts` exports `createWorldDockTabs(api?: RcsimApi): readonly DockTab[]`. After merging P1-F, please update `App.tsx` on `main` to pass `tabs={current === 'world' ? createWorldDockTabs(api) : undefined}` to `<BottomPanel api={api} projectDir={project.dir} jump={jump} tabs={...} />` while the 3D World environment is active. (Standalone `<WorldRoot api={fake.api} />` in unit tests continues to mount its own `<BottomPanel tabs={createWorldDockTabs(api)} />`.)
- **Open questions**:
  - None.
