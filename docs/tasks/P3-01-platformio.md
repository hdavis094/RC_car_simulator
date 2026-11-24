# P3-01 — PlatformIO flash and real serial monitor

Status: in-progress
Agent: Codex
Branch: ws/p3-01
Depends on: P2-01 integration (merged)

## Goal

Detect PlatformIO, build or flash the starter firmware and exchange serial bytes with a selected ESP32 port from Terminal.

## Owned paths

`apps/desktop/src/main/services/hardware/`, `apps/desktop/src/main/services/build.ts` and its tests, `apps/desktop/src/main/{index,ipc}.ts` for service registration, `apps/desktop/src/renderer/terminal/`, minimal `renderer/shell/{App,BottomPanel}.tsx` wiring, `apps/desktop/package.json`, `pnpm-lock.yaml`, `docs/HARDWARE.md`. The worker also updates this brief's Handoff.

## Read first

Read the `HardwareApi` and `BuildApi` contracts in `apps/desktop/src/shared/ipc.ts`, `packages/firmware-template/platformio.ini`, and the PRD Terminal section.

## Requirements

1. Discover an existing PlatformIO Core executable and offer installation from Terminal when absent. Install into an app-owned Python environment with user confirmation and an actionable error when prerequisites are missing.
2. Implement `BuildApi.start('esp32')` and flashing through PlatformIO in the current project directory. Reuse build output, diagnostics and cancellation. Validate the selected port, release the real serial handle before flashing, and prevent competing uploads or port opens.
3. List Linux `/dev/ttyUSB*` and `/dev/ttyACM*` ports and macOS `/dev/cu.*` USB serial ports. The Serial Monitor can select simulator or USB, pick the port and baud rate, show RX, send TX, and disconnect cleanly on device removal, reload or quit.
4. Document Linux device permissions and macOS CP210x/CH340 driver guidance. Verify current guidance with primary sources.

## Acceptance

- [ ] `pnpm verify` passes.
- [ ] Fake-driver tests cover argument boundaries, build/flash output, cancellation, serial connect/send/receive/disconnect and flash ownership of the port.
- [ ] Compile the real firmware with PlatformIO if the toolchain is reachable. Record local hardware verification separately from automated coverage.

## Out of scope

Hardware-in-the-loop and installing system drivers.

## Handoff

- **Built**:
- **Deviations from the brief**:
- **Contract change requests**:
- **Open questions**:
