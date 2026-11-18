# P2-01 Integration and the v1 Demo Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The PRD's v1 acceptance demo works in the app (Workbench → Build → Run in Sim → drive the oval avoiding cones, Serial Monitor and Network Console live, manual drive), and the same demo passes headless as the v1 scenario in `pnpm verify` on Linux and macOS.

**Architecture:** The main process gains three services that implement the remaining IPC stubs: `SimService` (`run.*`) launches an Electron `utilityProcess` sim host running sim-core's `Run` with the P1-H firmware bridge; `WorldEditService` (`worldEdit.*`) serves tracks and layouts and forwards live edits to the host; `ControlService` (`control.*`) wraps control-protocol's `ControlClient` and auto-connects to the firmware's mapped port. All sim logic lives in a plain `SimHost` class so it is tested in Node without Electron; the `utilityProcess` entry is a thin message pump. The headless v1 scenario uses the same sim-core path through `runScenario`.

**Tech Stack:** TypeScript (strict, ESM), Electron `utilityProcess` + `MessagePort`, electron-vite, sim-core / control-protocol / schema workspace packages, Vitest, Playwright for Electron, GitHub Actions (ubuntu-latest, macos-latest).

**Spec:** `docs/tasks/P2-01-integration.md` (brief) and `docs/PRD.md` → "v1 acceptance demo". Read the Handoff of every Phase 1 brief; the decisions below came from them.

## Global Constraints

- Owned paths: `apps/desktop/src/main/services/{sim,control,world-edit}/`, `e2e/`, `scenarios/`, plus minimal wiring edits elsewhere; every edit outside owned paths goes in the brief's Handoff with its reason.
- Contracts (`packages/schema/`, `packages/sim-protocol/`, `packages/control-protocol/`, `packages/sim-core/src/api/`, `apps/desktop/src/shared/`) change only as a separate `main` commit by the orchestrator (Task 1), never inside a feature task.
- Determinism: all sim time from `SimClock`, randomness from the session `Rng`; the same firmware, world and seed give a bit-identical run. The v1 scenario's seed-1 result (laps, collisions, serial output hash) must be identical on ubuntu-latest and macos-latest.
- SI units inside the sim; Y up, car forward −Z; Unix socket paths in `/tmp`, under 100 bytes; POSIX only; compiler from `$CXX`, falling back to `c++`.
- `sim-core` and `hal` stay headless; UI code only under `apps/desktop/src/renderer/`.
- Tests sit beside the code (`foo.ts` → `foo.test.ts`); `pnpm verify` must pass; conventional commits on `ws/p2-01`.
- v1 scenario: starter firmware (`packages/firmware-template`), track `oval`, cone layout `scenarios/worlds/v1-cones.json`, seed 1, 60 s, control timeline `mode auto` at t = 3 s, assertions `collisions == 0` and `laps >= 1`.

## Decisions carried in from Phase 1 (don't re-litigate)

- **`STEP.tcpInput` is deferred to Phase 3.** v1's control timeline is a single `mode auto` line at 3 s, and the cross-platform seed-1 gate (Task 2) catches any loopback-timing nondeterminism. Record this in the Handoff and in `docs/tasks/P3-backlog.md`.
- **`ScenarioResult.diagnostics` deferred**; **`ScenarioResult.serialHash` added** (Task 1), because the acceptance gate compares serial output across platforms.
- **`startupTimeoutMs`**: SimService passes it through `BridgeOptions` (already exported); no contract change.
- **Network Console tracker**: `ControlApi.state()` stays deferred; the renderer's per-api tracker works because `App.tsx` mounts the console at project open.
- **Renderer track copies** (`BUILTIN_OVAL_TRACK`, `BUILTIN_TECHNICAL_TRACK`, `OBSTACLE_DIMENSIONS`, marked `TODO(P2-01)`) are removed once `worldEdit.loadTrack` is real (Task 4).
- **Project template copy** excludes the firmware package's dev-only files (`scripts/`, `test/`, `package.json`, `.rcsim/`) (Task 6).

## Review Focus

1. **Run with unsaved Workbench edits.** Run in Sim uses `car.json` on disk; the renderer must save a dirty Workbench (or confirm) before `run.start`, never build a car the user isn't looking at. Test in Task 6.
2. **Firmware crash, stall or exit mid-run.** `RunInfo.state` becomes `ended` with the bridge's `RunEnd` (exit code / signal / stderr tail), the host stays usable for the next run, and control disconnects. Test in Task 3 (host) and Task 5 (control).
3. **Quitting or reloading the app during a run.** No orphaned firmware processes, sockets or utility process: `killAllFirmware()` on host exit, host killed on `before-quit` and renderer reload. Test in Task 3.
4. **Second Run while one is active; stop then start.** `start` rejects `busy`; after `stop`, a new run gets new net mappings and control reconnects to the new host port. Test in Task 3 and Task 5.
5. **Pause → edit → resume.** Edits made while paused reach the sim, survive resume, appear in `currentLayout()`; edits while running reject `busy`; `step` while running rejects `busy`. Test in Task 4.

---

### Task 1: Contract change — `ScenarioResult.serialHash` (orchestrator, on `main`)

**Files:**
- Modify: `packages/sim-core/src/api/scenario.ts` (`ScenarioResult`)
- Modify: `packages/sim-core/src/scenario/runner.ts`, `packages/sim-core/src/scenario/hash.ts`
- Test: `packages/sim-core/src/scenario/cli.test.ts` (or a new `runner.test.ts` beside `runner.ts`)

**Interfaces:**
- Produces: `ScenarioResult.serialHash: string` — lowercase hex SHA-256 of every byte the firmware wrote to Serial during the run, in tick order (empty run → hash of zero bytes). The CLI's JSON output includes it.

- [ ] **Step 1:** Test: two `runScenario` calls with the same firmware fixture and seed return equal `serialHash`; a fixture printing different text returns a different hash; a scripted (no-firmware) scenario returns `sha256('')` = `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`.
- [ ] **Step 2:** Run it, expect FAIL (`serialHash` undefined).
- [ ] **Step 3:** Add the field to the contract; in `runner.ts` feed every `run.on('serial')` chunk into an incremental `createHash('sha256')`.
- [ ] **Step 4:** `pnpm verify` passes.
- [ ] **Step 5:** Commit on `main`: `feat(sim-core): report a serial output hash in scenario results`. Push, then create the `ws/p2-01` worktree from this commit.

---

### Task 2: The v1 scenario, headless

**Files:**
- Create: `scenarios/v1.json`, `scenarios/worlds/v1-cones.json`, `scenarios/v1-control.json`, `scenarios/run.ts`, `scenarios/run.test.ts`, `scenarios/v1.expected.json`
- Modify (wiring): root `package.json` `test:scenarios`; delete `packages/sim-core/scripts/scenarios-placeholder.ts` and its script
- Modify if retuning is needed: `packages/firmware-template/src/main.cpp` tunables (record every change in the Handoff)

**Interfaces:**
- Consumes: `runScenario(spec: ScenarioSpec, io?: ScenarioIo): Promise<ScenarioResult>` from `@rcsim/sim-core`; `packages/hal/bin/build-sim <projectDir>` (writes `<projectDir>/.rcsim/build/firmware`).
- Produces: `runV1(options: { seed: number }): Promise<ScenarioResult>` exported from `scenarios/run.ts`; CLI `node scenarios/run.ts [--seeds 1-10]` prints one JSON line per seed and exits non-zero if seed 1 fails or deviates from `v1.expected.json`.

`scenarios/v1.json` is a `ScenarioSpec` with paths relative to `scenarios/`: `car` = the template's `car.json`, `world` = `worlds/v1-cones.json`, `seconds: 60`, `seed: 1`, `control: v1-control.json`, `assertions: ["collisions == 0", "laps >= 1"]` (parsed with `parseAssertion`). `firmware` is filled in by `run.ts` after building. `v1-cones.json` is a schema-valid `World` on track `oval` with a fixed cone layout that forces at least two avoidance manoeuvres per lap but leaves the racing line passable. `v1-control.json`: one entry `{ "tUs": 3000000, "message": { "t": "mode", "mode": "auto" } }` (field names per `packages/control-protocol/SPEC.md`).

- [ ] **Step 1:** Test `scenarios/run.test.ts`: `runV1({ seed: 1 })` passes both assertions, `end.kind` is the normal time-limit end, and `{laps, collisions, serialHash}` equals `v1.expected.json`. Mark the test with a 120 s timeout.
- [ ] **Step 2:** Run it; expect FAIL (no runner).
- [ ] **Step 3:** Implement `run.ts`: build the template once per process into a temp copy (never write into `packages/firmware-template`), then call `runScenario`. Run seeds 1–10; if seed 1 fails, retune the firmware's named avoidance tunables (keep changes minimal, rerun seeds 1–10), then write `v1.expected.json` from seed 1.
- [ ] **Step 4:** Point root `test:scenarios` at `node scenarios/run.ts`; delete the placeholder. `pnpm verify` passes. Record the seeds 1–10 table (pass/fail, laps, collisions) in the Handoff.
- [ ] **Step 5:** Commit `feat(scenarios): add the v1 scenario and its headless gate`. Push; CI must pass on both OSes with the same `v1.expected.json` (the cross-platform identity gate). If the noisy sim-core bound "60 s of sim time at 1 ms ticks in under 10 s" flakes on macOS again, raise only its CI headroom (e.g. 20 s when `process.env.CI`), with a comment.

---

### Task 3: Sim host and SimService (`run.*`)

**Files:**
- Create: `apps/desktop/src/main/services/sim/host-protocol.ts` (message types), `sim-host.ts` (+ `sim-host.test.ts`), `host-entry.ts` (utilityProcess entry), `sim-service.ts` (+ `sim-service.test.ts`), `index.ts`
- Modify (wiring): `apps/desktop/electron.vite.config.mts` (second main entry `sim-host` → `out/main/sim-host.js`); `apps/desktop/src/main/index.ts`, `apps/desktop/src/main/ipc.ts` (`MainServices` gains `run`)

**Interfaces:**
- Consumes: `createRun`, `createFirmwareSource(options: BridgeOptions)`, `killAllFirmware()`, `trackLibrary.load(id)` from `@rcsim/sim-core`; `checkWiring`, `World`, `Car` from `@rcsim/schema`; `BuildService.start('sim')` + `build.onEvent` (P1-D); `ProjectService` file access; contract types `RunApi`, `RunStartOptions`, `RunInfo`, `RunSpeed`, `NetMapping` from `apps/desktop/src/shared/ipc.ts`.
- Produces:
  - `type HostCommand` / `type HostEvent` (discriminated unions on `type`) in `host-protocol.ts`. Commands: `start {runId, car, catalog, world, track, seed, speed, paused, firmwarePath}`, `stop`, `pause`, `resume`, `step {ticks}`, `setSpeed {speed}`, `sendSerial {text}`, `restartFirmware`, `addObstacle {obstacle}`, `moveObstacle {id, position, yawDeg}`, `removeObstacle {id}`, `currentLayout`; each carries `requestId` and gets `reply {requestId, ok, value?, error?}`. Events: `snapshot`, `serial {text, tUs}`, `log {line, tUs}`, `status {info}`.
  - `class SimHost { constructor(post: (event: HostEvent) => void, deps?: { createSource?: (firmwarePath: string) => ActuatorSource; now?: () => number }); handle(command: HostCommand): Promise<unknown>; dispose(): Promise<void> }`
  - `class SimService implements RunApi { constructor(deps: { project: ProjectService; build: BuildService; catalog: CatalogService; spawnHost: () => HostChannel }) }` where `interface HostChannel { send(command: HostCommand): void; onMessage(listener: (event: HostEvent) => void): () => void; kill(): void }`. Also `SimService.worldEdit` methods used by Task 4: `addObstacle`, `moveObstacle`, `removeObstacle`, `currentLayout`, all rejecting `no-run` without a run and `busy` while running.

Behaviour to pin:
- `start`: rejects `busy` if a run is active; emits `status` `starting`; reads `car.json`, runs `checkWiring` (rejects `wiring-errors` on any error-level issue); writes `include/car_config.h`; starts `build.start('sim')` and awaits its terminal event (rejects `build-failed`); resolves the world (`worlds/*.json` path → read + `World.parse`; object → `World.parse`); sends `start` to the host; resolves with the first `running`/`paused` `RunInfo`.
- Pacing in `SimHost`: at speed `s`, sim time advances `s ×` wall time, stepping in batches each ≤ 16 ms wall; `'unpaced'` steps as fast as possible yielding to the event loop every batch. Snapshots post at most every 16 ms wall while running, and once after each pause, step and edit.
- Net mappings: every bridge `LISTEN` net event becomes a `NetMapping`; post `status` when the list changes.
- End: when the run ends (time limit isn't used in the app; firmware crash/stall/error, or `stop`), post `status` `ended` with `end`, call `killAllFirmware()`, keep the host alive for the next `start`.
- `host-entry.ts`: `process.parentPort.on('message', …)` → `SimHost.handle` → `postMessage`; on `process.on('exit')` and `SIGTERM`, `killAllFirmware()`.
- `SimService` kills the utility process on `dispose()` (wired to `before-quit` and to renderer reload in `renderer-lifecycle.ts`).

- [ ] **Step 1:** `sim-host.test.ts` with a scripted `ActuatorSource` (no firmware): start→running posts `status running` and snapshots; pause→step(5) advances exactly 5 ticks; `setSpeed(2)` doubles sim-per-wall over a 500 ms window ±20% using an injected `now`; `sendSerial` reaches `run.sendSerial`; a source that ends with `crashed` posts `status ended` with that `end` and a later `start` works; `stop` mid-run leaves no live firmware (spy on `killAllFirmware`).
- [ ] **Step 2:** `sim-service.test.ts` with a fake `HostChannel` and fake build/project: `start` while active rejects `busy`; wiring error rejects `wiring-errors` and never builds; build failure rejects `build-failed` and never starts the host; success writes the header then sends `start`; `step` while running rejects `busy`; `dispose()` calls `kill()`.
- [ ] **Step 3:** Run both; expect FAIL.
- [ ] **Step 4:** Implement the five files and the wiring.
- [ ] **Step 5:** Run both; PASS. One real-firmware test in `sim-host.test.ts`: build `packages/hal/test/fixtures/firmware` with `build-sim` into a temp dir, start, assert a serial line arrives and a `NetMapping` exists if the fixture listens; 60 s timeout.
- [ ] **Step 6:** Update `app.playwright.ts`'s "stubs reject with not-implemented" test: `run.*` no longer rejects; keep the assertion for any stub that remains. `pnpm verify` passes. Commit `feat(desktop): run the sim in a utility process behind run.*`.

---

### Task 4: WorldEditService (`worldEdit.*`) and the renderer cleanup

**Files:**
- Create: `apps/desktop/src/main/services/world-edit/world-edit-service.ts` (+ `.test.ts`), `index.ts`
- Modify (wiring): `apps/desktop/src/main/index.ts`, `apps/desktop/src/main/ipc.ts` (`MainServices` gains `worldEdit`)
- Modify (P1-F code, minimal): `apps/desktop/src/renderer/world/track-mesh.ts`, `scene-data.ts`, `WorldRoot.tsx` — remove the `TODO(P2-01)` track/obstacle copies and the `writeFile`/`readFile` save fallback; delete the drift-guard test

**Interfaces:**
- Consumes: `trackLibrary` from `@rcsim/sim-core`; `World` from `@rcsim/schema`; `ProjectService`; `SimService` live-edit methods (Task 3).
- Produces: `class WorldEditService implements WorldEditApi { constructor(deps: { project: ProjectService; sim: SimService }) }`. Obstacle sizes for the renderer come from the track/obstacle data the service returns; if the renderer still needs per-kind dimensions, expose them from `@rcsim/sim-core/api` only if already there, otherwise keep `OBSTACLE_DIMENSIONS` with its drift test and say so in the Handoff.

Behaviour to pin: `listTracks` → `['oval', 'technical']`; `loadTrack('nope')` rejects `not-found`; `listLayouts` → sorted `worlds/*.json` relative paths; `save` validates with `World` (rejects `invalid` with the schema message) and refuses paths outside `worlds/` or with `..`; `add/move/removeObstacle` and `currentLayout` delegate to `SimService` (so `no-run` / `busy` come from there).

- [ ] **Step 1:** Tests for each pinned behaviour, plus pause → `moveObstacle` → resume → `currentLayout()` shows the moved pose (using `SimHost` with a scripted source through an in-process `HostChannel`).
- [ ] **Step 2:** Run; FAIL. **Step 3:** Implement. **Step 4:** Run; PASS.
- [ ] **Step 5:** Remove the renderer fallbacks; P1-F's tests that exercised the fallback switch to a fake `worldEdit` from `apps/desktop/src/shared/fake-api.ts`. `pnpm verify` passes. Commit `feat(desktop): serve tracks, layouts and live world edits`.

---

### Task 5: ControlService (`control.*`)

**Files:**
- Create: `apps/desktop/src/main/services/control/control-service.ts` (+ `.test.ts`), `index.ts`
- Modify (wiring): `apps/desktop/src/main/index.ts`, `apps/desktop/src/main/ipc.ts` (`MainServices` gains `control`)

**Interfaces:**
- Consumes: `ControlClient`, `DEFAULT_PORT` (3333) from `@rcsim/control-protocol`; `SimService` status events (Task 3).
- Produces: `class ControlService implements ControlApi { constructor(deps: { onRunStatus: (listener: (info: RunInfo) => void) => () => void; createClient?: (options: ControlClientOptions) => ControlClient }) }`.

Behaviour to pin: on a `RunInfo` whose `netMappings` contains `{proto: 'tcp', firmwarePort: DEFAULT_PORT}`, auto-connect to `127.0.0.1:<hostPort>` unless the user has explicitly connected to another target; when the run ends or the mapping changes, close and (for a new mapping) reconnect; `connect({host, port})` points at any target, including a real car; `drive`/`setMode`/`estop`/`sendRaw` return `false` when not connected; `onRaw` reports both directions.

- [ ] **Step 1:** Tests against `fake-car.ts` from control-protocol: auto-connect on a mapping, reconnect to a new port after a second run, disconnect on `ended`, explicit `connect` overrides auto-connect, raw lines both ways.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS. **Step 5:** `pnpm verify`; commit `feat(desktop): connect control to the running car`.

---

### Task 6: App wiring the demo needs

**Files (all wiring outside owned paths; list each in the Handoff):**
- Modify: `apps/desktop/src/main/services/project.ts` — template copy filter excludes `scripts/`, `test/`, `package.json`, `.rcsim/` from `packages/firmware-template`; test in `project.test.ts`.
- Modify: the renderer's Run trigger (`renderer/world/WorldRoot.tsx` and/or `renderer/shell/App.tsx`, wherever `run.start` is called) — if `hasUnsavedChanges()` (shell `unsaved.ts`), save the Workbench and editor documents first (or confirm, matching the Build button's existing save-all behaviour); test in the owning component's test file.

- [ ] **Step 1:** Failing tests: a new project contains no `scripts/`, `test/` or `package.json` from the template but does contain `src/`, `include/`, `car.json`, `platformio.ini`; Run with a dirty Workbench saves `car.json` before `run.start` is called.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS; `pnpm verify`; commit `fix(desktop): save before running and copy only the car project from the template`.

---

### Task 7: Playwright demo test

**Files:**
- Create: `e2e/demo.spec.ts` (shares the launch helper pattern of `e2e/app.spec.ts`)

**Interfaces:** consumes the whole app; no new code interfaces.

Steps the test drives (each with an assertion, waiting on UI state, never fixed sleeps): new project from the starter firmware → Workbench shows zero wiring errors → Terminal Build succeeds → 3D World: place a cone → Run → Serial Monitor shows the starter firmware's boot banner (`Donkey Car starter firmware`) → Network Console shows a telemetry line → switch to manual → hold `W` for ~1 s of wall time and assert the car's `data-car-z` moved toward −Z → Stop → `RunInfo.state` `ended`.

- [ ] **Step 1:** Write the test; run `pnpm test:e2e`; expect it to fail at the first not-yet-working step, if any.
- [ ] **Step 2:** Fix what it finds inside owned paths (or as listed wiring); PASS locally.
- [ ] **Step 3:** Push; CI green on both OSes. Commit `test(e2e): drive the v1 demo end to end`.

---

### Task 8: `docs/DEMO.md`, the Handoff, and the review gate

**Files:**
- Create: `docs/DEMO.md`
- Modify: `docs/tasks/P2-01-integration.md` (Handoff), `docs/tasks/P3-backlog.md` (deferred items)

`DEMO.md` is a checklist the user walks through: setup per platform (Linux: toolchain, `pnpm install`, `pnpm --filter @rcsim/desktop dev`; macOS: Xcode CLT for Apple clang, same commands), then the PRD demo step by step with expected results, gamepad driving, and connecting an external client with `nc 127.0.0.1 <hostPort>` (where to read the port: the run status / Network Console), sending `{"t":"mode","mode":"manual"}`.

- [ ] **Step 1:** Write `DEMO.md`; walk it yourself on Linux and fix anything it contradicts.
- [ ] **Step 2:** Fill the Handoff: built, edits outside owned paths (each with reason), deviations (tcpInput deferral, retuned constants), seeds 1–10 table, open questions. Add deferred items to `P3-backlog.md`: `STEP.tcpInput`, `ScenarioResult.diagnostics`, `ControlApi.state()`, and the Phase 1 non-blocking follow-ups recorded in each P1 Handoff.
- [ ] **Step 3:** Whole-branch review by a non-Claude reviewer (Codex, else OpenCode) against the brief and AGENTS.md; fix blocking findings.
- [ ] **Step 4:** Merge `ws/p2-01` to `main` after `pnpm verify` and CI on both OSes; set `Status: in-review` (not `done`: the last acceptance item is the user's own walkthrough). **Stop for the user's demo review.**
