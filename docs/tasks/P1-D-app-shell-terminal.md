# P1-D — app: main process services, shell, Terminal environment

Status: in-progress
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

- [ ] `pnpm verify` passes
- [ ] Playwright:
  - [ ] new project from template → open `src/main.cpp` → introduce a typo → Build → click the error → the editor is at the right line
  - [ ] a shell panel runs `pwd` and shows the project path
- [ ] the renderer has no Node access (assert `typeof require === 'undefined'`)

## Out of scope

Workbench (P1-E), 3D World (P1-F), run wiring (P2-01), PlatformIO flashing (Phase 3).

## Handoff

- **Built**:
- **Deviations from the brief**:
- **Contract change requests**:
- **Open questions**:
