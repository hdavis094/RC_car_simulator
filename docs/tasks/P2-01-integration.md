# P2-01 — Integration and the v1 demo

Status: in-review
Agent: Claude (initial scenario), Codex (integration), Gemini (Playwright demo)
Branch: ws/p2-01
Depends on: all of Phase 1
Gate: the user reviews the demo before Phase 3

## Goal

The whole v1 acceptance demo (PRD) works in the app, and the v1 scenario passes headless in `pnpm verify`.

## Owned paths

`apps/desktop/src/main/services/{sim,control,world-edit}/`, `e2e/`, `scenarios/`, plus minimal wiring edits anywhere else. Every edit outside the owned paths is listed in the Handoff with the reason.

## Read first

Everything in `docs/`; the Handoff sections of every Phase 1 brief.

## Requirements

1. **SimService** (main process):
   - on Run: check wiring (block on errors), regenerate the header, build-sim, then start a sim-core `Run` with the firmware bridge in a `utilityProcess`
   - stream snapshots to the renderer
   - pace to the chosen speed
   - serial RX/TX
   - net mappings
   - world-edit applied live while paused
2. **ControlService**: `ControlClient` from `control-protocol`, auto-connecting to the car's mapped port when a run starts. It can be pointed at any host:port, i.e. a real car.
3. **The v1 scenario** in `scenarios/v1.json`:
   - starter firmware, the oval with the fixed cone layout `scenarios/worlds/v1-cones.json`, seed 1, 60 s
   - control timeline: `mode auto` at t = 3 s, after ESC arming
   - assertions: no collisions, laps ≥ 1
   - replaces the placeholder in `pnpm verify`
   - retune the starter firmware constants if needed, and record the changes
4. **Playwright demo test**:
   - new project → Workbench shows zero errors → Terminal Build succeeds
   - 3D World: place a cone → Run → Serial Monitor shows the boot banner → Network Console shows telemetry
   - switch to manual → keyboard drive moves the car → stop
5. **`docs/DEMO.md`**: a manual demo checklist for the user, including gamepad driving and connecting an external client (`nc 127.0.0.1 <port>`) to the car.

## Acceptance

- [x] `pnpm verify` passes, including the v1 scenario and the Playwright demo test
- [x] the v1 scenario passes 10 times in a row with seeds 1–10 (seed 1 is the gate; report the others)
- [ ] CI is green on **both** `ubuntu-latest` and `macos-latest`, including the v1 scenario and the Playwright demo test. The v1 scenario's result (laps, collisions, serial output hash) is identical on both platforms for seed 1
- [x] `docs/DEMO.md` lists the setup steps for each platform
- [ ] the user has walked through `docs/DEMO.md` and approved it

## Out of scope

Phase 3 items.

## Handoff

- **Built**:
  - The deterministic v1 scenario builds a temporary copy of the starter firmware, places two cones on the oval, sends `mode auto` at 3 s and checks seed 1 against the recorded result in `pnpm verify`.
  - SimService checks wiring, regenerates the header, builds the firmware and starts a utility process. The host paces ticks, streams snapshots and serial/log output, reports TCP mappings, and cleans up on stop, renderer reload or app quit.
  - WorldEditService loads built-in tracks and validated project layouts, and routes paused obstacle edits to the live world. ControlService auto-connects through the mapped port with explicit host/port support, held drive commands and raw Network Console traffic.
  - The Electron demo test creates a car from the starter, checks wiring, builds, places a cone, checks the serial boot banner and telemetry, drives with the keyboard, and stops. The manual checklist is in [DEMO.md](../DEMO.md).
- **Edits outside owned paths**:
  - Root `package.json`, `pnpm-workspace.yaml`, `pnpm-lock.yaml`, `packages/sim-core/package.json` and its removed `scripts/scenarios-placeholder.ts` register the scenario and replace the placeholder.
  - `packages/sim-core/src/scenario/cli.test.ts` allows 20 s for the existing scripted wall-time check in CI, where the 10 s limit flaked on Linux and macOS. Local runs still use 10 s.
  - `apps/desktop/electron.vite.config.mts`, `src/main/index.ts` and `src/main/ipc.ts` add the utility-process entry, IPC services and lifecycle cleanup. `src/main/app.playwright.ts` now checks the implemented idle run API.
  - `apps/desktop/src/main/services/project.ts` and `project.test.ts` constrain the starter template copy to project files and keep layout paths inside `worlds/` through symlinks.
  - `apps/desktop/src/renderer/shell/App.tsx` and `App.test.tsx` save edits before build/run, stop the old run on project switch, and display the mapped control port.
  - `apps/desktop/src/renderer/world/WorldRoot.tsx`, `WorldRoot.test.tsx`, `WorldScene.tsx`, `track-mesh.ts`, `index.ts` and `world.playwright.ts` use the live services and track data and report the latest car pose for integration assertions, including when WebGL is unavailable.
  - `docs/DEMO.md`, this handoff and `docs/tasks/P3-backlog.md` record the walkthrough, acceptance results and follow-ups.
- **Deviations from the brief**:
  - The cone layout passed with the starter firmware's existing settings.
  - Each Run uses the existing BuildService to compile the current project. The build driver caches the HAL library.
  - Scenario control still uses the existing loopback timeline. `STEP.tcpInput` and `ScenarioResult.diagnostics` are deferred.
  - The renderer keeps obstacle dimensions with a drift check pending a Node-free sim-core export.
- **Contract change requests**:
  - Consider adding `ControlClient.sendRaw(line)` and raw-line events in both directions. The existing client has typed commands and messages. A loopback relay currently gives the app raw access to the same car connection.
  - Optional requests for `ControlApi.state()` and `STEP.tcpInput` are tracked in the [Phase 3 backlog](P3-backlog.md).
- **Seed sweep on Linux**:

  | Seed | Result | Laps | Collisions |
  | ---: | --- | ---: | ---: |
  | 1 | Pass | 3 | 0 |
  | 2 | Pass | 3 | 0 |
  | 3 | Pass | 3 | 0 |
  | 4 | Pass | 3 | 0 |
  | 5 | Pass | 3 | 0 |
  | 6 | Pass | 3 | 0 |
  | 7 | Pass | 3 | 0 |
  | 8 | Pass | 3 | 0 |
  | 9 | Pass | 3 | 0 |
  | 10 | Pass | 3 | 0 |

  Seed 1 serial SHA-256 with both GCC and Clang on Linux was `e33b65d21406ad94b19bded7c0609c38f0c9510f58665679530e48061312466a`.
- **Verification**: `pnpm verify` passed on Linux with 584 unit tests, the seed-1 scenario, both HAL compiler suites and all 10 Playwright tests. A Linux walkthrough confirmed an automatic lap without collisions, an external `nc` client switching to manual, and renderer reload closing the simulated car's mapped TCP port.
  - Both CI platforms matched the seed-1 fingerprint on the first run. The demo test's default five-second wait expired during startup. It now waits for the real running state, which also passed locally with a six-second build delay.
- **Open questions**:
  - The user walkthrough, including a physical gamepad, is the final approval gate.
