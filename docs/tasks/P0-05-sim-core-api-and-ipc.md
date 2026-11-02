# P0-05 — Contract: sim-core public API and app IPC

Status: in-review
Agent: Claude (Opus)
Branch: ws/p0-05
Depends on: P0-03, P0-04

## Goal

Fix the TypeScript interfaces between the parts of sim-core and between the app's processes, so the Phase 1 tasks can build in parallel against types instead of against each other's unfinished code. Stub implementations make everything compile and let each task fake its neighbours.

## Owned paths

`packages/sim-core/src/api/`, `apps/desktop/src/shared/`

## Read first

`docs/ARCHITECTURE.md` (whole), `packages/schema`, `packages/sim-protocol`.

## Requirements

1. **`sim-core/src/api/`**: interfaces with doc comments, no logic. Cover:
   - **`SimClock`**: tick, now µs, a seeded `Rng` with named streams per device, so adding a sensor doesn't shift other sensors' noise
   - **`World`**: loading a world + track, the obstacle CRUD used by the editor, raycast queries
   - **`Vehicle`**: built from car + catalog. Takes actuator commands (steer angle rad, motor command); exposes pose, velocity, wheel states, collision events
   - **`ActuatorModel`**: maps a PWM pulse to a physical command, per behavior template
   - **`SensorModel`**: per template; `update(t, world, vehicle, rng) → Reading | null`
   - **`ActuatorSource`**: where PWM comes from. One implementation is the firmware bridge, another a scripted list for tests
   - **`Run`** orchestration: create from car project + world + seed; `step(n)`; pause; snapshot
   - **`StateSnapshot`**: what the renderer draws
   - **`ScenarioSpec`** / `ScenarioResult`
2. **Stubs** for each interface: compile-only fakes that tests and other tasks can use, for example a `FakeVehicle` that drives in a straight line.
3. **`apps/desktop/src/shared/ipc.ts`**: a typed renderer↔main API exposed by the preload. Group it by service:
   - **project**: open, read/write `car.json`, list and read/write files, watch
   - **catalog**: list built-in + custom parts, save a custom part
   - **build**: start, stream output, structured errors with file/line/col
   - **pty**: spawn, write, resize, data events
   - **run**: start/stop/pause/step/speed, snapshot stream, serial rx/tx, net mappings
   - **world-edit**: add/move/remove obstacle, save layout
   - **control**: connect to a host:port, send command, telemetry stream
   - **gamepad** state stays in the renderer and is sent through **control**
4. A short `README.md` in each folder: how to use the stubs to fake a neighbour.

## Acceptance

- [x] `pnpm verify` passes
- [x] each Phase 1 brief's "Read first" points to interfaces that exist here
- [x] a compile-only test proves that a `Run` can be assembled from the stubs alone and stepped

## Out of scope

Implementations.

## Handoff

- **Built**:
  - **`packages/sim-core/src/api/`**: interfaces with doc comments and no logic.
    - Clock and randomness: `SimClock`, `Rng`, `RngStreams` (named seeded streams).
    - Physics: `World` (physics step, raycasts, obstacle CRUD, `toWorldFile`) and `Vehicle` (`VehicleCommand`, `VehicleState`, `WheelState`).
    - Models: `ActuatorModel` (PWM → steering/drive output, with the signed linkage formula) and `SensorModel` (`update` → readings, plus `onGpioWrite`/`takeGpioEdges` for the HC-SR04, `beams()`).
    - Orchestration: `ActuatorSource` (TickInput/TickOutput mirroring STEP/STEP_DONE; `ActuatorSourceEnded` with stalled/crashed/finished), and `Run` with the documented six-step tick order and events.
    - Data and scenarios: `StateSnapshot` (plain data), `ScenarioSpec`/`ScenarioResult` with `parseAssertion`, `PartContext`.
    - The README covers conventions, the tick order and how to fake each neighbour.
  - **`src/api/stubs/`** (`@rcsim/sim-core/stubs`):
    - `createRngStreams`, a usable mulberry32 with name-hashed streams;
    - `FakeClock`, `FakeWorld`/`FakeVehicle` (flat world, sphere obstacles, straight-line car);
    - linear fake actuator and sensor models, and `FakeActuatorSource` (a timeline that records its inputs);
    - `createFakeRun`, the reference tick loop, which accepts real pieces one at a time;
    - `partContexts` and `deviceKindOf`.
  - **`apps/desktop/src/shared/ipc.ts`**: `RcsimApi` grouped by service: project, catalog, build, pty, run, worldEdit and control. Gamepad and keyboard input stay in the renderer and go through `control.drive`.
    - `IPC_METHODS`/`IPC_EVENTS` channel tables, type-checked against the interfaces and tested for completeness.
    - `EventArgs`, IPC error codes with `ipcErrorMessage`/`parseIpcError`, and the `window.rcsim` declaration.
  - **`shared/fake-api.ts`**: `createFakeRcsimApi`, an in-memory main for renderer tests. It records calls, writes byte-identical headers, and exposes emitters for snapshots, serial, telemetry and pty data. Plus a README.
  - **Tests**: a Run assembled from the stubs alone steps 100 ticks and drives forward with right steering for pulses above neutral. It passes a device table and previous-tick readings to the source, counts a collision, ends with its source, and edits and saves obstacles. Also: RNG stream independence, channel-table completeness, the IPC error round-trip, and each fake service.
- **Deviations from the brief**:
  - **Contract changes on `main` (additive) that this task needed**:
    - `@rcsim/schema` exports `gpioAssignments(car, catalog)`, used by `PartContext.gpioPins`;
    - `@rcsim/control-protocol/messages` is a Node-free entry point, and `ConnectionState` moved there.
  - **Outside the owned paths**, done as orchestrator:
    - `packages/sim-core/package.json` gains the `./api` and `./stubs` exports;
    - `apps/desktop/package.json` gains `@rcsim/sim-protocol` (with its electron-vite bundling entry);
    - the root `eslint.config.js` gives `src/shared/` the renderer's import boundary, allowing only Node-free package entry points.
  - **`World` owns the vehicle** (`createVehicle`) and the physics step. The brief listed `Vehicle` separately; Rapier's raycast vehicle lives inside its world.
  - **Pacing is the caller's**: `Run` has `step(n)` but no pause, so pause, single-step and speed live in the app (`RunApi`).
- **Review round 1.** Both reviews (Codex adversarial, Claude `code-review`) asked for changes. All blocking findings are fixed:
  - **HC-SR04 edge causality** (both): a response starts no earlier than the tick after its trigger, shifted whole so pulse widths are kept.
  - **Wheel transforms** (Codex): world-frame pose including chassis, steer and spin.
  - **No Track for the renderer** (Claude): `TrackLibrary` in the API; `worldEdit.listTracks`/`loadTrack` and `RunInfo.trackId` in IPC.
  - **HC-SR04 readings** (Claude): it has none; `update` returns `[]`, and the fake follows that.

  Non-blocking findings fixed:
  - **Reference loop:** GPIO edges merged in ascending tUs; a tick's inputs taken before awaiting the source, so serial queued meanwhile isn't lost; the run ends exactly once; `stop()` may come during a step; concurrent `step` rejected; other errors become `{kind:'error'}`.
  - **Firmware reboot:** `ActuatorSource.restart?`, `Run.restartFirmware`, `RunApi.restartFirmware`. Also `CreateFirmwareSource` for P1-H.
  - **`RunApi.start`** is the whole Run in Sim action (check wiring, build if stale, start), with the `starting` state and the `build-failed` code.
  - **Per-part RNG streams** come through `PartContext.stream(suffix)`.
  - **SI:** `chassisToWorld(offsetM, yawRad, pitchRad)`.
  - **Models only for wired parts.**
  - **Scenarios:** `parseAssertion` accepts `maxSpeed`, and `SCENARIO_METRICS` is derived.
  - **Fake API:** paused-only edits and steps, a cleared layout on stop, cloned results, unique obstacle ids, built-in ids rejected, broken part files listed as problems.
  - **Fake vehicle:** placement and wheels rotate with the car.
  - **Tests** sit beside their code (`rng.test.ts`, `fake-api.test.ts`).
  - **Briefs (orchestrator):**
    - P1-A owns `src/run/`, `src/index.ts`, its package.json deps and bin, and the `TrackLibrary`; its timeline uses `gpio`;
    - P1-H owns the CLI's `--firmware`/`--control` options;
    - P1-F reads tracks over IPC.
- **Contract change requests**: none.
- **Open questions**:
  - `deviceKindOf` in the stubs follows SPEC.md's table by part id. P1-H owns the real mapping, and may want a field on part definitions later.

- **Review round 2 (Codex).** Two P2s in the reference loop, both fixed with tests:
  - **Unwired sensors:** the wiring check covered only dividers, so an unwired ToF produced readings with no device to map to. It now covers every sensor.
  - **Errors outside `source.step`:** a throw from `world.step` or a sensor rejected `step` and left the run `running`. A failure anywhere in a tick now ends the run once with `{kind:'error'}`. `Run` documents that the caller still calls `stop()` to release the source.
