# P0-05 — Contract: sim-core public API and app IPC

Status: todo
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

- [ ] `pnpm verify` passes
- [ ] each Phase 1 brief's "Read first" points to interfaces that exist here
- [ ] a compile-only test proves that a `Run` can be assembled from the stubs alone and stepped

## Out of scope

Implementations.

## Handoff

- **Built**:
- **Deviations from the brief**:
- **Open questions**:
