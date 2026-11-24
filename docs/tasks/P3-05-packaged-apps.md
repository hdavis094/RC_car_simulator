# P3-05 — Packaged Linux and macOS apps

Status: in-review
Agent: OpenCode
Branch: ws/p3-05
Depends on: P3-01 and P3-04 for final package verification

## Goal

Build a Linux x64 AppImage and unsigned macOS DMGs for Apple Silicon and Intel with the same project and simulator workflows as source builds.

## Owned paths

`apps/desktop/electron-builder*`, `apps/desktop/scripts/`, `apps/desktop/package.json`, `apps/desktop/src/main/` for packaged runtime paths and compiler detection, minimal `packages/hal/bin/build-sim` packaging support, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `.github/workflows/package.yml`, `docs/INSTALL.md`. The worker also updates this brief's Handoff.

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

- **Built**: OpenCode added the electron-builder workflow and packaged resource paths. The follow-up includes the HAL build helpers, stages the HAL compile with relative Make targets, runs a real project and firmware smoke test from the bundle, uses current Apple Silicon and Intel runner labels, and prepares executable native PTY helpers.
  - The Linux AppImage created a project in a path containing spaces, compiled it with the bundled Electron runtime and ran the starter firmware. The smoke test also starts a native PTY and lists USB serial ports. CI exercises the AppImage and the app bundles for both macOS architectures.
  - [Initial integration package run](https://github.com/hdavis094/RC_car_simulator/actions/runs/45504267260) produced all three artifacts and passed the package smoke tests.
- **Deviations from the brief**: The macOS binaries use ad-hoc signing and the DMG uses no Developer ID or notarization.
- **Contract change requests**: None.
- **Open questions**: Verify all package jobs with the completed Phase 3 dependency set.
