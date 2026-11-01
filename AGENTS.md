# Donkey Car Simulator

A Linux desktop app for designing an ESP32-powered RC car and testing its firmware in a deterministic 3D simulation before it touches hardware. Several AI agents build it in parallel, each working from one task brief.

## Where things are

- **Your task**: the brief in `docs/tasks/` you were dispatched with. Its scope and acceptance criteria win over anything you infer.
- **What and why**: `docs/PRD.md`. **How the pieces fit**: `docs/ARCHITECTURE.md`. **Why a choice was made**: `docs/adr/`.
- **Words**: `GLOSSARY.md`. Use its terms in code, comments and commits; reach for it whenever a name is in doubt.
- **Orchestrating** (dispatching, reviewing, merging): `docs/ORCHESTRATOR.md`. Workers never need it.

## Ownership

Every brief lists **owned paths**. Write only inside them. Everything else is read-only to you, especially the **contracts**:

- `packages/schema/`
- `packages/sim-protocol/`
- `packages/control-protocol/`
- `packages/sim-core/src/api/`
- `apps/desktop/src/shared/`

If a contract blocks you, write a **Contract change request** in your brief's Handoff section (what, why, the smallest change that unblocks you), then continue with a local workaround or stop. The orchestrator changes contracts on `main`; you rebase.

If you need a dependency, add it to your own package's `package.json`. On a `pnpm-lock.yaml` conflict, regenerate the lockfile with `pnpm install`.

## Done

A task is done when all three hold:

1. `pnpm verify` passes in your worktree (use `pnpm verify:fast` while iterating).
2. Your work is committed on your branch (`ws/<task-id>`) with conventional commits: `feat(sim-core): add lockstep clock`.
3. The brief's **Handoff** section is filled in: what you built, deviations from the brief, contract change requests, open questions.

If `pnpm verify` still fails after three honest attempts at a fix, stop, record the failure output and your diagnosis in Handoff, and set `Status: blocked`.

## Conventions

- **TypeScript**: strict mode, ESM, ESLint + Prettier as configured. Types flow from the Zod schemas in `packages/schema`; infer them rather than redeclaring.
- **C++**: C++17, formatted with the repo `.clang-format`. `hal` mirrors the Arduino/ESP32 API names exactly so the same sketch compiles for the real board.
- **Units**: SI everywhere inside the sim (metres, seconds, radians, kilograms). Convert only at the edges: part files (mm, g, µs as labelled), UI, firmware APIs.
- **Coordinates**: right-handed, Y up, car forward is −Z, matching Three.js.
- **Determinism in `sim-core`**: all time comes from `SimClock`, all randomness from the session's seeded `Rng`. The same firmware, world and seed must produce a bit-identical run.
- **Layering**: `sim-core` and `hal` run headless. UI code lives only in `apps/desktop/src/renderer/`.
- **Tests sit beside the code** they cover (`foo.ts` → `foo.test.ts`; `hal/src/x.cpp` → `hal/test/x_test.cpp`).
