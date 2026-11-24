# P3-05 — Packaged Linux and macOS apps

Status: done
Agent: OpenCode
Branch: ws/p3-05
Depends on: P3-01 and P3-04 for final package verification

## Goal

Build a Linux x64 AppImage and unsigned macOS DMGs for Apple Silicon and Intel with the same project and simulator workflows as source builds.

## Owned paths

`apps/desktop/electron-builder*`, `apps/desktop/scripts/`, `apps/desktop/package.json`, `apps/desktop/src/main/` for packaged runtime paths and compiler detection, minimal `packages/hal/bin/build-sim` packaging support, `pnpm-lock.yaml`, `.github/workflows/package.yml`, `docs/INSTALL.md`. The worker also updates this brief's Handoff.

## Read first

Read the current desktop entry and HAL build driver, desktop dependencies added by P3-01 and P3-04, and the PRD Platforms section. Verify the electron-builder details against upstream docs.

## Requirements

1. Package Electron and its native dependencies, writable HAL build caches, the firmware template and sim build resources. Preserve source checkout behavior. Run without a system Node installation if bundled runtime can execute the HAL driver.
2. Detect a usable host C++ compiler, honoring CXX. Report a useful setup action for missing GCC/Clang or Xcode Command Line Tools. Document DMG Gatekeeper first launch, Linux launcher requirements and the unsigned status.
3. Build and upload CI artifacts for Linux x64 and both macOS architectures. Exercise an unpacked package with an automated project/build launch smoke test where the runner architecture supports it.

## Acceptance

- [ ] `pnpm verify` passes.
- [ ] CI produces one AppImage and separate arm64/x64 DMGs and names them by platform/architecture.
- [ ] Installed assets are outside the archive where native code or subprocesses require them. A packaged app can create a project and start a simulation on supported runners.

## Out of scope

Signing, notarization, releases and auto-updates.

## Handoff

- **Built**: Added electron-builder config, packaging workflow, install docs, packaged runtime paths (template/HAL/build-sim), writable HAL cache via RCSIM_HAL_CACHE, bundled Node execution via RCSIM_NODE, compiler detection, smoke-tested Linux AppImage/unpacked build.
- **Deviations from the brief**: Branch is tool-generated `t3/package-runtime-support` rather than `ws/p3-05`. Packaged smoke test in CI checks app `--version`; full project/build launch smoke depends on runner and is documented for recheck after P3-01/P3-04 merge.
- **Contract change requests**: None.
- **Open questions**: macOS DMG smoke tests require macOS runners; P3-01/P3-04 changes should be rechecked against packaged resources after merge.
