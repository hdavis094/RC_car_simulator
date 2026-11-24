# P3-02 — Network fault injection

Status: done
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

- [x] `pnpm verify` passes.
- [x] UI and service tests cover unit conversion, invalid values, reset and paused application.
- [x] The headless scenario demonstrates pre-dropout motion/drive and neutral after dropout. It uses the existing sim time and seeded behavior.

## Out of scope

New network protocol fields and real-hardware network faults.

## Handoff

- **Built**:
  - Wired `run.setNetFaults` through `apps/desktop/src/main/services/sim/sim-service.ts`, `host-protocol.ts`, and `sim-host.ts` to `Run.setNetFaults`, with IPC validation for unsigned 32-bit integer `latencyUs`, integer `lossPpm` (`0..1_000_000`), and boolean `dropout`, plus paused-run queueing that takes effect on the next step/resume. Added unit tests in `sim-host.test.ts` and `sim-service.test.ts`.
  - Added `apps/desktop/src/renderer/world/NetworkFaultControls.tsx` (and unit/integration tests in `NetworkFaultControls.test.tsx`) with minimal hookup in `WorldRoot.tsx` and re-exports in `index.ts`. Converts latency (`ms` → integer `µs`) and packet loss (`%` → integer `ppm`), toggles dropout, provides a clear Reset, displays availability and paused-queue status, validates inputs before IPC, and surfaces IPC errors via `role="alert"`.
  - Added the headless `scenarios/network-dropout*` scenario (`network-dropout.json`, `network-dropout-world.json`, `network-dropout-control.json`, `network-dropout.ts`, `network-dropout.test.ts`) running in the `pnpm test:scenarios` gate alongside the unchanged seed-1 v1 scenario. Builds and runs the real starter firmware with a held 20 Hz manual drive stream, injects dropout at 4.010 s sim time, verifies pre-dropout motion and non-neutral PWM (`1640 µs` ESC / `1475 µs` steering), verifies the 500 ms failsafe neutralizes both actuators to `1500 µs` and logs `failsafe: no drive for 500 ms` at `4.500 s` sim time, holds neutral while drive commands continue, and repeats bit-identically with seed 1.
  - Documented the feature and headless scenario in `docs/NETWORK-FAULTS.md`.
- **Deviations from the brief**:
  - Committed on the tool-provided worktree branch `t3/network-fault-simulation` (per dispatch instructions) rather than creating `ws/p3-02` directly.
- **Contract change requests**: None.
- **Open questions**: None.
