# P1-D — app: main process services, shell, Terminal environment

Status: in-review
Agent: Codex (gpt-6.1-sol)
Branch: ws/p1-d
Depends on: P0 (all)
Wave: 1

## Goal

The Electron app opens a car project, and the Terminal environment edits, builds and shells into it. The main process services behind it are the ones the other environments use.

## Owned paths

`apps/desktop/src/main/`, `apps/desktop/src/preload/`, `apps/desktop/src/renderer/shell/`, `apps/desktop/src/renderer/terminal/`

## Read first

`apps/desktop/src/shared/ipc.ts` and README, ARCHITECTURE.md → Processes at run time, Builds.

## Requirements

1. **Main services** implementing `ipc.ts`:
   - **ProjectService**: open folder, new project from `packages/firmware-template`, file read/write/watch, `car.json` read/write
   - **CatalogService**: built-in catalog + project `parts/`
   - **BuildService**: runs hal `build-sim`; parses GCC and Clang diagnostics into structured errors
   - **PtyService**: node-pty, starting the user's `$SHELL` (zsh on macOS, usually bash on Linux) as a login shell
   - on macOS, the app menu and `CmdOrCtrl` shortcuts follow platform conventions
   - stub `run`, `world-edit` and `control` handlers returning "not implemented" (P2-01 wires them)
2. **Preload**: exposes exactly the `ipc.ts` API via `contextBridge`. Context isolation on, node integration off.
3. **Shell**:
   - app frame and environment switcher (Workbench / Terminal / 3D World)
   - project open / new / recent
   - status bar: build status, run status
   - a shared dockable bottom panel that the 3D World reuses
4. **Terminal environment**:
   - file tree
   - Monaco editor with C++ highlighting, tabs, save, and dirty markers
   - Build button
   - build output panel with clickable errors that jump to file:line:col
   - xterm.js shell panel(s) in the project directory
   - a Serial Monitor panel component, with the send line and autoscroll, bound to the `run` serial stream

## Acceptance

- [x] `pnpm verify` passes
- [x] Playwright:
  - [x] new project from template → open `src/main.cpp` → introduce a typo → Build → click the error → the editor is at the right line
  - [x] a shell panel runs `pwd` and shows the project path
- [x] the renderer has no Node access (assert `typeof require === 'undefined'`)

## Out of scope

Workbench (P1-E), 3D World (P1-F), run wiring (P2-01), PlatformIO flashing (Phase 3).

## Handoff

- **Built**:
  - Main ProjectService (folder picker, starter firmware copy, persistent recent projects, file tree/read/write/watch, validated car files and generated headers), CatalogService, BuildService and node-pty PtyService. Project-relative access rejects traversal and symlink escapes; generated/build/dependency directories are excluded from the file tree.
  - BuildService runs `packages/hal/bin/build-sim <project-dir>` without shell interpolation, passes output through unchanged, parses GCC/Clang diagnostics, prevents concurrent builds and cancels the compiler process group. Missing drivers produce a failed build with an actionable error.
  - The sandboxed preload exposes exactly the IPC contract, including removable subscriptions; run, world-edit and control methods reject with `not-implemented`. Main rejects IPC from other windows/frames and prevents renderer navigation/new windows. Native menus use platform roles and CmdOrCtrl shortcuts, with unsaved-edit protection.
  - App frame, project open/new/recent, three environment tabs, build/run status, and one persistent dock with bottom/right docking, size control and collapse. The dock is outside environment roots, so 3D World reuses the same shells and Serial Monitor. `BottomPanel` and `DockTab` are exported for later Network Console integration.
  - Terminal file tree, lazy Monaco C++ editor, tabs/view state, save/dirty markers, save-before-build, compiler markers and exact diagnostic navigation. External edits reload clean documents and preserve dirty documents with an explicit conflict choice. Multiple xterm shell panels support resize/close. Serial Monitor subscribes to run serial events, retains bounded output, sends lines, supports clear and autoscroll.
  - Verification after review round 1: `pnpm verify` passes (311 Vitest tests, HAL tests with GCC and Clang, seven Electron tests including the smoke test; scenario runner is still the P0 placeholder). Dedicated Electron acceptance suite covers template copy → typo → build → exact line/column, real-shell `pwd`, dock/environment persistence, exact API/no renderer Node access, external-file conflicts, and Serial Monitor events/send stub. The suite now also checks renderer reload cleanup; all six app tests pass locally with both GCC and Clang.
  - App suite command from repo root: `pnpm --filter @rcsim/desktop build && pnpm exec playwright test --project=app apps/desktop/src/main/app.playwright.ts`. Prefix the Playwright command with `CXX=clang++` to exercise Clang. The root Playwright config now discovers the colocated app suite, so `pnpm verify` and CI run it; the redundant main-directory config was removed by the orchestrator. Package scripts and shared `e2e/` are unchanged.
- **Deviations from the brief**:
  - P1-C's HAL driver and P1-G's complete starter firmware are absent in this checkout. Production uses the specified HAL driver path. Only when that driver is absent, the dedicated Electron tests supply a temporary syntax-only build driver using the real system compiler and an empty Arduino header for the P0 starter placeholder. This proves the UI/IPC/compiler flow, not HAL linking or a firmware run. Tests automatically use the real driver when available. `RCSIM_BUILD_SIM` permits a main-process development/test driver override; `RCSIM_USER_DATA_DIR` isolates Electron test data.
  - Until the starter firmware supplies car.json, new-project creation uses schema's exampleCar and generates its header. Once the template includes car.json, that file is preserved and used instead.
  - ESP32 builds reject with `not-implemented`, consistent with Phase 3 flashing being out of scope.
  - Added dependencies only in the desktop package, with corresponding lockfile updates (the dependency exception in AGENTS.md). No contract or other worker implementation was edited.
- **Contract change requests**:
  - No IPC/schema changes required.
  - The workspace native-install request is **accepted and resolved on main**: `pnpm-workspace.yaml` now allows node-pty's install script. No outstanding workspace configuration requests.
- **Open questions**:
  - P2-01 should wire the currently stubbed run/control/world-edit services and validate against the real HAL/starter firmware when they land. Root e2e integration is complete.
  - macOS menu, login-shell and shortcut behavior follows platform conventions but has only been exercised on Linux locally; macOS CI remains the platform proof.

### Review round 1

- **Findings 1–3 (blocking):** `resolvePath` now checks `lstat` after `realpath` returns ENOENT and rejects dangling links before climbing. The regression writes the link itself and asserts that the outside target remains absent; nested new files inside the project still work. Temporary project, shell and Electron fixture roots are canonicalised with `realpath`, fixing the `/var` versus `/private/var` assertions. IPC maps ENOENT to `not-found`, preserves existing contract errors, and leaves other failures as `io`. Recents persistence is best-effort so a settings failure cannot turn a successful project open into an error.
- **Findings 4–6:** Compiler paths are resolved and normalised before applying the inside/outside-project rule. Builds force `LC_ALL`, `LC_MESSAGES` and `LANGUAGE` to `C`. GNU/Apple linker failures produce diagnostics, with non-navigable summaries labelled “Linker” when no file is known. The acceptance test waits up to 60 seconds for a build and locates the named typo without assuming the fallback driver's severity wording.
- **Findings 7–9:** Main-frame document navigation and `render-process-gone` dispose ptys and terminate the compiler process group; same-document navigation and subframes preserve resources. Pending shell spawns are also cancelled on disposal. Development URL/build-driver/user-data overrides are honoured only outside packaged apps. IPC checks both sender identity and the trusted renderer URL (exact entry document for file URLs; origin for the dev server). The default Electron session denies permission requests.
- **Finding 10:** Added colocated unit tests for IPC sender validation/error wrapping/event cleanup, editor conflicts/save failures/in-flight saves, and build session output replacement, including a newly caught silent-build stale-output case. Additional service/lifecycle tests cover the findings above; Electron proves a shell spawned without any React cleanup hook is disposed by reload.
- **Additional macOS blocking finding:** The installed node-pty 1.1 Darwin helpers are mode 0644, consistent with upstream microsoft/node-pty#850/#919 and the CI `posix_spawnp failed` symptom. PtyService resolves the helper from node-pty's actual selected native directory, maps ASAR paths to `.asar.unpacked`, and repairs missing execute bits before a macOS spawn. It validates `$SHELL` and falls back to executable `/bin/zsh` on macOS or `/bin/sh` elsewhere. Spawn failures report the shell, canonical cwd, selected helper path and original error. Tests exercise 0644 repair, native helper discovery, ASAR mapping, a real fallback shell, disposal during a pending spawn, and native-spawn error context. No shell tests are skipped.
- **Validation:** `pnpm verify` passes locally: 311 Vitest tests, GCC/Clang HAL checks, and all seven root Playwright tests; the six app tests also pass with `CXX=clang++`. Regression tests first reproduced the dangling-link write, recents failure, wrong missing-file error code, untrusted-origin acceptance, path/locale/linker gaps, and stale build output before their fixes. No findings declined. macOS CI must still confirm the helper fix; it cannot be executed on this Linux host. HAL linking remains untested while P1-C's real driver is absent; the existing compiler fixture fallback remains explicit.
- **Status:** in-review. No rebase or push performed in this round.
