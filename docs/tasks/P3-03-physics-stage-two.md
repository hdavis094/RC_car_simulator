# P3-03 — Physics stage 2

Status: in-progress
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

- [ ] `pnpm verify` passes.
- [ ] Tests cover repeatability, centre-of-gravity shift, grip limits/slip, unloaded vs. loaded ADC voltage, and ESC brake/neutral/reverse transitions.
- [ ] Stage-1 checks and the v1 scenario fingerprint still pass. A stage-2 CLI run completes with the selected model.

## Out of scope

Detailed tyre compound or thermal simulation and stage-1 retuning.

## Handoff

- **Built**:
- **Deviations from the brief**:
- **Contract change requests**:
- **Open questions**:
