# P0-02 — Repo scaffold, verify pipeline, CI

Status: in-review
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
6. **GitHub Actions**: a workflow running `pnpm verify` on push and PR, as a matrix over `ubuntu-latest` and `macos-latest`. Playwright runs under `xvfb-run` on Linux and directly on macOS. The workflow is inert until a remote exists.
7. **Both compilers**: hal's `test` script builds and runs the suite once per available compiler (`g++`, `clang++`; on macOS, `c++` is Apple clang) and fails if any of them fails.
8. Replace the `.gitignore` entries if the tooling needs more (add `.DS_Store`).

## Acceptance

- [x] `pnpm install && pnpm verify` passes from a fresh clone
- [x] the Playwright smoke test opens the app and navigates to all three environments
- [x] `pnpm verify:fast` runs in under 60 s on stubs
- [x] hal's stub test passes with both `g++` and `clang++` locally
- [x] if a GitHub remote exists, the macOS CI job is green; otherwise say so in the Handoff

## Out of scope

Any schema, protocol or real feature code.

## Handoff

- **Built**:
  - **Workspace**: pnpm 12 workspace (`packages/*`, `apps/*`), with every package from the Modules table as a `@rcsim/*` stub. Each one has `test` and `typecheck` scripts.
  - **TypeScript**: `tsconfig.base.json` is strict NodeNext ESM with `erasableSyntaxOnly` and `allowImportingTsExtensions`. Relative imports therefore carry `.ts` extensions, and plain Node 26 can run the sources directly; the scenario placeholder already runs as `node scripts/scenarios-placeholder.ts`. Packages export `./src/index.ts`; there is no build step.
  - **Desktop app**: `apps/desktop` uses electron-vite 6, React 19 and Zustand 5. The shell (`src/renderer/shell/`) switches between `WorkbenchRoot`, `TerminalRoot` and `WorldRoot`, each in its own folder. Main and preload bundle the `@rcsim/*` workspace packages through `build.externalizeDeps.exclude`.
  - **hal**: Makefile (C++17, `-Wall -Wextra -Wpedantic -Werror`, `$CXX` falling back to `c++`), vendored doctest 2.5.3, and one stub test. `scripts/test-all-compilers.sh` runs the suite with `$CXX`, `g++` and `clang++`, and fails if any of them fails.
  - **Verify pipeline**: `pnpm verify` = format check (Prettier, plus clang-format for hal) → ESLint → typecheck → Vitest (one run over every package's project) → hal tests → scenario placeholder → Playwright Electron smoke test. `pnpm verify:fast` stops after the hal tests.
  - **C++ formatting**: hal's clang-format is the pinned WASM build `@wasm-fmt/clang-format` 23.1.1, a hal devDependency. Every OS gets the same formatter, and the check fails if it is missing.
  - **Lint guards**: ESLint keeps `react`, `react-dom`, `electron`, `zustand`, `@rcsim/desktop` and their subpaths out of `packages/*`. It keeps `electron` and every Node built-in (`fs`, `node:fs`, `fs/promises`) out of the renderer.
  - **CI**: `.github/workflows/ci.yml` runs on Ubuntu (`xvfb-run -a pnpm verify`) and macOS (`pnpm verify`). Both were green on run 41271299483. The macOS job ran hal with Apple clang, and the Playwright test.
  - **Timings here**: `verify:fast` takes about 3 s, full `verify` about 9 s. A fresh clone passed `pnpm install --frozen-lockfile && pnpm verify`.
- **Deviations from the brief**:
  - TypeScript is pinned to `~6.0.3` rather than 7.x, because typescript-eslint 8 supports only `<6.1`.
  - Prettier ignores `*.md`, so the hand-written docs and briefs aren't reflowed. It also ignores the C++ packages, which clang-format covers.
  - `apps/desktop` is CommonJS (no `"type": "module"`), so the sandboxed preload can stay CJS. Its config files are `.mts` for that reason.
  - The Playwright test and `pnpm dev` strip `ELECTRON_RUN_AS_NODE`. T3 Code and VS Code export it, and it makes Electron start as plain Node.
- **Review** (Codex `gpt-6.1-sol`, round 1, changes requested). Fixed:
  - **Blocking**: the C++ format check passed silently when clang-format was missing (the macOS CI job). It now uses the pinned WASM clang-format and fails if it is missing.
  - The lint layering rules missed subpaths (`react-dom/client`) and bare Node built-ins (`fs`). Both are now caught.
  - The Handoff was empty at the reviewed commit. It is now filled in.
- **Contract change requests**: none.
- **Open questions**:
  - The GitHub repo is **public**, but ORCHESTRATOR.md says private. That is for the user to decide.
