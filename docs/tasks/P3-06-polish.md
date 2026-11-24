# P3-06 — Desktop polish

Status: todo
Agent: Codex
Branch: ws/p3-06
Depends on: P3-01, P3-02, P3-03, P3-04, P3-05

## Goal

Make setup and routine actions easier to discover through recent projects, shortcuts, persistent settings and actionable error messages.

## Owned paths

`apps/desktop/src/renderer/{shell,terminal}/`, `apps/desktop/src/main/{index,ipc}.ts`, `apps/desktop/src/main/services/settings/`, `docs/DEMO.md`, and colocated tests. The orchestrator owns shared IPC additions. The worker also updates this brief's Handoff.

## Read first

Read the app shell, project history and session store code, the completed Phase 3 briefs, and the PRD Environments section.

## Requirements

1. Give recent projects a clear open flow with missing-folder feedback. Align platform-appropriate shortcuts and the visible commands they invoke while preserving unsaved-edit guards.
2. Persist practical app preferences such as dock placement and simulation speed. Provide a first-run view pointing to creating or opening a project and where to set up hardware.
3. Replace ambiguous user-visible errors on project, build/run and hardware paths with messages that name an action the user can take. Keep the existing build diagnostics and test IDs used by integration tests.

## Acceptance

- [ ] `pnpm verify` passes.
- [ ] Tests cover persistence across reloads, missing recent projects, and an accessible first-run path.
- [ ] Playwright still passes the existing v1 demo and Phase 3 setup actions are documented.

## Out of scope

A redesign, new simulator capabilities and changing unrelated preferences.

## Handoff

- **Built**:
- **Deviations from the brief**:
- **Contract change requests**:
- **Open questions**:
