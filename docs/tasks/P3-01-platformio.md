# P3-01 — PlatformIO flash and real serial monitor

Status: done
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

- [x] `pnpm verify` passes.
- [x] Fake-driver tests cover argument boundaries, build/flash output, cancellation, serial connect/send/receive/disconnect and flash ownership of the port.
- [x] Compile the real firmware with PlatformIO if the toolchain is reachable. Record local hardware verification separately from automated coverage.

## Out of scope

Hardware-in-the-loop and installing system drivers.

## Handoff

- **Built** added PlatformIO discovery and confirmed installation in an app-owned Python environment, ESP32 builds and uploads through BuildService, and simulator/USB selection in Terminal's Serial Monitor. Uploads release the serial handle before starting PlatformIO and reserve the port until the process exits. The hardware guide covers Linux permissions and macOS USB bridge drivers.
- **Deviations from the brief** none.
- **Contract change requests** none. The prebuilt `serialport-rs` dependency works with the existing workspace install policy.
- **Verification** `pnpm install --frozen-lockfile` and `VITEST_MAX_WORKERS=1 pnpm verify` passed. The full run included 597 Vitest unit tests, 43 HAL tests each with GCC and Clang, one scenario test and 10 Electron tests. The single Vitest worker avoided an existing Workbench test's five-second timeout observed with default concurrency.
- **Automated hardware coverage** fake PlatformIO and serial drivers cover argument boundaries, install confirmation, compiler diagnostics, upload output and cancellation, serial exchange and removal, and exclusive upload ownership. A renderer test covers source selection, baud, USB RX/TX and flash dispatch.
- **Real firmware build** `pio run -e esp32dev` succeeded on Linux x86-64 with PlatformIO Core 6.2.0 and produced a 1,019,696-byte `firmware.bin`. The cold build emitted dependency warnings, including a non-fatal `esp-idf-size` warning about `--ng`. BuildService also built the starter firmware successfully from the copy of the project using Core installed by the app's own installer.
- **Local hardware check** the read-only Linux scan found zero USB serial ports. The native driver passed a 115200-baud pseudo-terminal RX/TX and disconnect check. Physical ESP32 upload and macOS hardware were unavailable locally.
- **Open questions** none.
