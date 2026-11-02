# P1-A — sim-core: clock, world, vehicle physics, actuators

Status: in-review
Agent: Claude (Sonnet sub-agent)
Branch: ws/p1-a
Depends on: P0 (all)
Wave: 1

## Goal

A headless, deterministic simulation in which a car built from `car.json` drives one of the two tracks, collides with obstacles, and responds to PWM through realistic servo and ESC models. Physics stage 1 (arcade-believable), with actuator realism included. Every other sim feature hangs off this.

## Owned paths

`packages/sim-core/src/{clock,world,vehicle,actuators,run,scenario}/`, `packages/sim-core/src/index.ts`, `packages/sim-core/assets/`, and adding your dependencies and the `rcsim` bin to `packages/sim-core/package.json`

## Read first

`packages/sim-core/src/api/` and its README, `packages/schema` (chassis, behavior params, world, track), ADR 0003, ARCHITECTURE.md → Testing.

## Requirements

1. **`SimClock`** and seeded `Rng` with named streams, per the API.
2. **World**:
   - Rapier deterministic WASM build (`@dimforge/rapier3d-deterministic-compat`)
   - the ground, plus track walls generated from track data
   - obstacles as colliders, with live add/move/remove
   - raycast query service for sensors
3. **Tracks** in `assets/tracks/`:
   - `oval`: about 12 × 6 m, 1.2 m lane
   - `technical`: hairpin, chicane, about 20 m lap
   - start/finish lines and lap counting
4. **Vehicle**: Rapier `DynamicRayCastVehicleController`, built from the chassis definition (wheelbase, track width, wheel radius, mass, CoG), with Ackermann steering and drive torque on the driven wheels. Expose collision events with obstacles and walls.
5. **Actuators**:
   - servo (pulse → target angle, slew-limited)
   - ESC (no output until neutral is held for the arming time, deadband, throttle curve; no reverse logic in stage 1)
6. **Scripted `ActuatorSource`**: a timeline of `ScriptedPwm` entries, `{tUs, gpio, pulseUs}`. Also the `TrackLibrary` (`assets/tracks/<id>.json` by id).
7. **`Run`**: assemble the clock, world, vehicle and actuators. Expose `step(n)` and `snapshot()`.
8. **Scenario CLI** `rcsim`:
   - `run --car <car.json> --world <world.json> --seconds N --seed S --script <timeline.json> --assert <expr>...`
   - assertions: `collisions == 0`, `laps >= 1`, `maxSpeed < x`
   - prints JSON results and exits non-zero on a failed assertion
   - the bridge (P1-H) adds `--firmware` later through the `ActuatorSource` interface

## Acceptance

- [ ] `pnpm verify` passes
- [ ] **determinism**: the same inputs and seed, run twice, give bit-identical snapshot hashes after 10 000 ticks
- [ ] **steering**: at full lock and walking pace, the turn radius is within ±10% of `wheelbase / tan(maxSteer)`
- [ ] **ESC arming**: a throttle pulse before neutral has been held for the arming time produces no motion
- [ ] **collisions**: a scripted straight run into a cone reports exactly one collision event
- [ ] **laps**: a scripted timeline that completes the oval counts one lap
- [ ] **speed**: `rcsim run` of 60 s at 1 ms ticks finishes in under 10 s of wall time

## Out of scope

Sensors (P1-B), the firmware bridge (P1-H), rendering, stage 2 physics (tyre slip, battery sag, ESC reverse double-tap).

## Handoff

- **Built**:
  - **Clock** (`src/clock/`): `TickClock` (integer µs) and `createRngStreams`, adopted from `api/stubs/rng.ts` so sequences match the stubs.
  - **World** (`src/world/`): Rapier deterministic WASM (`loadRapier`), `PhysicsWorld`/`createWorld`, `trackLibrary`, `LapCounter`.
    - Ground, plus walls generated from the centreline: both lane edges, straight pieces on straights, 4 mm chord error on curves.
    - Obstacles as fixed colliders (`cone`, `box`, `wall`, `ramp`; sizes in `obstacles.ts`) with live add/move/remove and `toWorldFile()`.
    - `raycast` service using collision groups (`excludeVehicle` default true).
    - Collision events with one event per touch (see Deviations).
  - **Tracks** (`assets/tracks/oval.json`, `technical.json`): the oval is a 27 m stadium, 12 × 6 m outside, 1.2 m lane. The technical track is a 20.3 m lap with a hairpin, a chicane and a second hairpin. Both are start/finish-lined and 0.75 m behind the line at start. A test checks the tightest bend is wider than the car can turn.
  - **Vehicle** (`src/vehicle/`): `RapierVehicle` on `DynamicRayCastVehicleController`.
    - Built from the chassis: wheelbase, track width, wheel radius, CoG, mass = chassis + all parts.
    - Ackermann steering, DC-motor drive (stall torque, back-EMF, final-drive ratio, battery voltage) on the driven wheels, rolling resistance.
    - Suspension hard points sized so the chassis frame rests on the ground.
  - **Actuators** (`src/actuators/`): `createServoModel` (linear pulse → angle, slew-limited, deadband, holds without signal) and `createEscModel` (arming, deadband, throttle curve, reverse/brake from pulses below neutral).
  - **Run** (`src/run/`): `createRun` follows the tick order in `api/run.ts` and returns a `MeasuredRun`, a `Run` plus `metrics()`.
  - **Scenario** (`src/scenario/`): `createScriptedSource` (scripted `ActuatorSource`), `runScenario`, `snapshotHash`, and the `rcsim` bin (`bin.ts`, wired in `package.json`; `rcsim run --car --world --seconds [--seed] [--tick-us] --script --assert…`).
    - Prints JSON. Exit 0 when all assertions hold, 1 when one fails or the run ended abnormally, 2 for bad arguments or input.
  - **Acceptance** (numbers from this machine):
    - **Determinism:** equal snapshot hashes after 10 000 ticks, in-process and across two `rcsim` processes.
    - **Steering:** the full-lock rear-axle radius fitted to the trajectory is 0.632 m against 0.630 m expected (0.4%), left and right, at about 1.3 m/s.
    - **ESC arming:** a throttle pulse at 1 s with 3 s arming gives 0 m and 0 m/s over 8 s. Interrupted neutral restarts the wait.
    - **Collisions:** a straight run into a cone gives exactly one collision (a box likewise; a wall hit gives one `wall` event, not one per wall piece).
    - **Laps:** a recorded pure-pursuit timeline, replayed as a plain scripted timeline, counts 1 lap on the oval (19.3 s) and 1 on the technical track (15.6 s), with 0 collisions.
    - **Speed:** 60 s at 1 ms ticks takes about 0.5 s of wall time, in-process and through the `rcsim` executable.
  - `pnpm verify` passes (362 tests, hal with GCC and Clang, Playwright).
- **Deviations from the brief**:
  - **Sensors.** P1-B has not merged, so `run/default-models.ts` defaults to the API's `createFakeSensorModel`. Swapping in P1-B's `sensors/` is a one-line change there.
  - **Stubs imported by production code.** `run.ts` imports `partContexts`/`deviceKindOf` from `api/stubs/fake-run.ts`, and `clock/` re-exports the stubs' RNG, as the API README invites. Moving them out of `stubs/` would be a contract tidy-up.
  - **Run returns more than `Run`.** `createRun` returns `MeasuredRun` (adds `metrics()`: collisions, laps, maxSpeedMps, distanceM, simSeconds). The scenario runner needs it. It is a subtype, so `CreateRun` is satisfied.
  - **Car mass and CoG.** Mass is the chassis plus every part's `massG`, since the chassis mass excludes the fitted parts. The CoG is the chassis's alone, and parts' masses are not placed.
  - **Collision debounce.** Contacts are counted per target (all wall pieces are one target "wall"). A new collision needs the previous contact to have ended at least 250 ms earlier, so a bounce or a scrape along the wall is one event. Ground contact is not reported. `impulseNs` is the summed contact impulse at the step where the contact began.
  - **Obstacles are fixed.** A cone does not tip over when hit.
  - **Reverse.** Pulses below neutral drive negative duty directly (reverse, and braking while moving forward) when the part's `reverse` is true. No double-tap logic, per stage 1. At zero duty the motor is open circuit and the car coasts against rolling resistance (0.08 × weight). There is no drag brake.
  - **Raycasts and edits.** Rapier updates its spatial index only inside a step. Raycasts are valid after the first `step`, and obstacle edits are visible to them from the next step. A zero-length "refresh" step corrupted the car's collider (it ended up disabled), so none is used. A `Run` always steps before it casts sensor rays, so this is invisible there.
  - **Laps.** A start/finish crossing counts only after the car has travelled at least half a lap since the last counted crossing, or since the start, so starting behind the line or jittering across it does not score. `lapTimesUs` holds lap durations: the first from the run start, the rest from the previous crossing.
  - **`rcsim` seed.** `--seed` defaults to the world file's seed. Nothing random reaches the physics yet, so seeds change nothing until sensors land.
  - **`test:scenarios`.** Still the placeholder script. The `package.json` change is limited to the Rapier dependency and the `bin`.
- **Contract change requests**:
  - None blocking. `ChassisDefinition.maxSteeringAngleDeg` is described in `schema` as "Inner front wheel at full lock", but `ActuatorOutput`/`VehicleCommand` and the brief's acceptance define `maxSteer` as the centre-wheel angle (turn radius `wheelbase / tan(maxSteer)`). I followed the API and brief: at full lock the inner wheel turns 33.3° and the outer 24.1° for the default chassis. Suggest correcting the schema description to "virtual centre wheel (Ackermann) at full lock", or confirming the inner-wheel reading, which would make the radius 19% larger and fail the acceptance check.
- **Open questions**:
  - **`--firmware`.** `rcsim` accepts it but needs a source factory: `main(argv, { createFirmwareSource })`, or `ScenarioIo.createFirmwareSource` for `runScenario`. `src/scenario/bin.ts` passes none, and `scenario/` is not P1-H-owned. Who wires the bridge in: P1-H via a contract note, or P2-01?
  - **Cross-platform determinism.** Bit-identical hashes are proven across two processes on Linux only. macOS (Apple Silicon and Intel) is covered by CI alone.
  - **Tuning.** Suspension, tyre grip (μ 1.5), rolling resistance and the motor model (no efficiency loss, nominal battery voltage) are stage 1 values chosen to look right, not measured. Top speed is about 7.5 m/s (no-load), and walking pace (about 1.4 m/s) is motor duty 0.2.
