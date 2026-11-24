# P3-02 — Network fault injection

Status: in-progress
Agent: Gemini
Branch: ws/p3-02
Depends on: P2-01 integration (merged)

## Goal

Apply latency, loss and dropout to an active simulation from 3D World, and demonstrate the starter firmware failsafe with deterministic sim timing.

## Owned paths

`apps/desktop/src/main/services/sim/{host-protocol,sim-host,sim-service}.ts` and their tests, one network fault UI module and minimal hookup in `apps/desktop/src/renderer/world/`, `scenarios/network-dropout*`, and `docs/NETWORK-FAULTS.md`. The worker also updates this brief's Handoff.

## Read first

Read `NetFaults` in `packages/sim-protocol`, `Run.setNetFaults`, `RunApi.setNetFaults`, `packages/hal`'s existing fault implementation, and the P2-01 demo.

## Requirements

1. Wire `run.setNetFaults` from the renderer through the utility process to `Run.setNetFaults`. Validate integer µs/ppm and boolean dropout at IPC. An edit submitted while paused takes effect on the next step.
2. Add 3D World controls with latency in ms, loss as a percentage, dropout and a clear reset. Show when settings can be applied and report IPC errors.
3. Add a headless scenario in the existing scenario gate proving that driving is applied before a dropout and the manual failsafe neutralizes it after 500 ms of sim time. Use the real starter firmware and a held drive stream or timed drive commands. Keep existing seed-1 acceptance intact.

## Acceptance

- [ ] `pnpm verify` passes.
- [ ] UI and service tests cover unit conversion, invalid values, reset and paused application.
- [ ] The headless scenario demonstrates pre-dropout motion/drive and neutral after dropout. It uses the existing sim time and seeded behavior.

## Out of scope

New network protocol fields and real-hardware network faults.

## Handoff

- **Built**:
- **Deviations from the brief**:
- **Contract change requests**:
- **Open questions**:
