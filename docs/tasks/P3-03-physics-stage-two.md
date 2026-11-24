# P3-03 — Physics stage 2

Status: in-review
Agent: Claude
Branch: ws/p3-03
Depends on: P2-01 integration (merged)

## Goal

Provide a deterministic stage-2 vehicle and actuator model with tyre slip, placed mass, battery sag and ESC braking and reverse.

## Owned paths

`packages/sim-core/src/{actuators,vehicle,world,sensors,run,scenario}/`, `packages/sim-core/src/index.ts`, `docs/PHYSICS.md`. Coordinate any additional contract changes with the orchestrator. The worker also updates this brief's Handoff.

## Read first

Read the stage-2 PRD and `packages/sim-core/src/api/{run,vehicle,scenario}.ts`. Use existing schema `Car`, placement, chassis, ESC and battery definitions. The public selector is `physicsStage?: 1 | 2`.

## Requirements

1. Make stage 2 an opt-in for headless callers with `--physics-stage 2` and the corresponding `RunOptions` / `ScenarioSpec` fields. Preserve stage 1 by default in the headless API and preserve the v1 golden scenario. The orchestrator will wire the desktop selector.
2. Use placed part masses to derive vehicle centre of gravity, bounded tyre forces to represent grip and slip, and pack parameters to model voltage sag under motor load that the voltage divider and firmware ADC see.
3. Model brake-first and neutral-then-reverse double-tap on a reversible ESC. Respect arming and disabled reverse. Keep stage-2 calculations clock-driven and deterministic.
4. Document model assumptions and the dimensions of numerical parameters.

## Acceptance

- [x] `pnpm verify` passes.
- [x] Tests cover repeatability, centre-of-gravity shift, grip limits/slip, unloaded vs. loaded ADC voltage, and ESC brake/neutral/reverse transitions.
- [x] Stage-1 checks and the v1 scenario fingerprint still pass. A stage-2 CLI run completes with the selected model.

## Out of scope

Detailed tyre compound or thermal simulation and stage-1 retuning.

## Handoff

- **Built**:
  - `physicsStage` is honoured by `createRun`, `runScenario` and `rcsim run --physics-stage <1|2>`. The default is 1; any other value is rejected (CLI exit code 2).
  - Placed part masses set the centre of gravity, wheel loads and rotational inertia (`vehicle/mass.ts`).
  - Stage-2 tyres: Rapier does the suspension only; `vehicle/tyre.ts` applies slip-angle and drive/brake impulses inside a friction circle.
  - Motor and pack solved together (`vehicle/powertrain.ts`). The voltage divider reads the sagging pack at 100 Hz.
  - ESC brake, neutral, reverse (`actuators/gearbox.ts`). With reverse disabled it only brakes.
  - `docs/PHYSICS.md`: model, parameters with dimensions, and what is not modelled.
  - Tests include a stage-2 golden snapshot hash and a compiled sketch that reads the sag with `analogReadMilliVolts`.
- **Verification** (Linux x86-64, Node 26.12.0): `pnpm verify` passes: 654 unit tests in 59 files, the hal and firmware suites, 1 scenario test and 10 Playwright tests. The stage-1 golden hash and `v1.expected.json` are unchanged. The starter firmware also completes the v1 course in stage 2 (2 laps, 0 collisions, against 3 laps in stage 1; run by hand, not gated). macOS was not run: CI has to confirm the new golden hash there. No physical ESP32 is involved in this task.
- **Deviations from the brief**:
  - Based on `bd055aa`, one docs-only commit after `f970f5f`. Worked on `t3/physics-stage-two`, the tool's branch, for the orchestrator to put on `ws/p3-03`.
  - Beyond the brief: neutral must last one PWM frame to count between the two ESC taps, and stage 2 samples the divider at 100 Hz (stage 1 stays at 10 Hz).
  - `createEscModel` takes an optional gearbox. The mount-point resolution moved from `sensors/pose.ts` to `vehicle/mount.ts`, shared with the mass model.
  - Not modelled (see `docs/PHYSICS.md`): wheel inertia, ESC motor-speed feedback, state of charge, non-motor loads, creep-free parking on slopes.
  - The 60 s CLI wall-time test failed once in a baseline run before any change (11.1 s against 10 s, load average about 12). It passed in `pnpm verify`.
- **Contract change requests**:
  - Accepted `brake?: boolean` on the drive actuator output and vehicle command. The implementation now uses the shared types and keeps the flag absent from legacy snapshots.
- **Desktop verification**: Selecting stage 2 in Settings reached the run host. A live starter-firmware run moved under throttle and showed a drop in battery voltage.
- **Open questions**:
  - Should the second ESC tap wait for the motor to stop, as some real ESCs do? It needs speed feedback into the ESC model.
  - A custom `createSensorModel` cannot see the pack voltage (`SensorContext` has no field for it). Only the built-in divider shows sag. Add one only if overrides need it.
