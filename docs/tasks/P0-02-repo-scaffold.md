# P0-02 — Repo scaffold, verify pipeline, CI

Status: todo
Agent: Claude (Opus)
Branch: ws/p0-02
Depends on: P0-01

## Goal

A pnpm workspace where every package and the app exist as compiling stubs, and `pnpm verify` runs every kind of check (green on stubs). Every later task plugs into this pipeline instead of inventing its own.

## Owned paths

Repo root (`package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, ESLint/Prettier config, `.clang-format`, `.github/`), and the initial skeleton of every package and `apps/desktop`. Later tasks own those package interiors.

## Read first

`AGENTS.md`, `docs/ARCHITECTURE.md` (Modules, Testing, Ownership map).

## Requirements

1. pnpm workspace with every package in the Modules table of ARCHITECTURE.md. Node 26. TypeScript strict ESM, using project references or a per-package `tsc --noEmit`.
2. **`apps/desktop`**: electron-vite + React + Zustand skeleton.
   - Main, preload and renderer entry points.
   - Empty `src/main/`, `src/preload/` and `src/renderer/{shell,terminal,workbench,world}/` folders, each with an index stub.
   - The shell switches between three placeholder roots named `WorkbenchRoot`, `TerminalRoot` and `WorldRoot`. Their files live in the folders their tasks own.
3. **`packages/hal`**:
   - Makefile-based C++17 build.
   - `third_party/doctest.h` vendored.
   - One passing doctest.
   - `pnpm --filter @rcsim/hal test` runs it.
4. **Scripts**: `pnpm verify` runs, in order: format check, lint, typecheck, Vitest (all TS packages), hal tests, scenario tests (a placeholder that passes until P2-01), and Playwright (one test: the app launches and all three environments can be reached). `pnpm verify:fast` is the same without Playwright and scenarios.
5. **Package scope** `@rcsim/*`. Each package has `test` and `typecheck` scripts.
6. **GitHub Actions**: a workflow running `pnpm verify` on push and PR. Playwright runs under `xvfb-run`. The workflow is inert until a remote exists.
7. Replace the `.gitignore` entries if the tooling needs more.

## Acceptance

- [ ] `pnpm install && pnpm verify` passes from a fresh clone
- [ ] the Playwright smoke test opens the app and navigates to all three environments
- [ ] `pnpm verify:fast` runs in under 60 s on stubs

## Out of scope

Any schema, protocol or real feature code.

## Handoff

- **Built**:
- **Deviations from the brief**:
- **Contract change requests**:
- **Open questions**:
