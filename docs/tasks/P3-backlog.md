# Phase 3 — Backlog

The orchestrator writes full briefs from `_TEMPLATE.md` for these after the user approves the P2-01 demo. Suggested agents in brackets.

- **P3-01 PlatformIO flash + real serial monitor** [Codex]: detect or install PlatformIO on Linux and macOS, `pio run -e esp32dev -t upload`, and a serial port picker covering `/dev/ttyUSB*` and `/dev/ttyACM*` on Linux and `/dev/cu.*` on macOS. Note the CP210x/CH340 USB-serial driver for macOS. Bind the Serial Monitor to the real port.
- **P3-02 Network fault injection UI** [Antigravity]: a panel in the 3D World for latency, loss and dropout, sent to hal through `STEP` fault settings; a scenario proving the failsafe fires under dropout.
- **P3-03 Physics stage 2** [Claude]: tyre grip and slip, mass and CoG from placed parts, battery sag under load feeding the ADC reading, ESC brake/reverse double-tap.
- **P3-04 WebSocket transport for the control protocol** [Codex]: so a phone browser can drive the car.
- **P3-05 Packaged apps** [Codex]: electron-builder producing an AppImage for Linux and an unsigned `.dmg` for macOS (arm64 + x64). The app has to find a C++ compiler at run time and send the user to Xcode Command Line Tools if it's missing. Document Gatekeeper's first-launch step.
- **P3-06 Polish** [any]: recent projects, keyboard shortcuts, settings, error-message pass, first-run experience.

## Deferred integration and Phase 1 follow-ups

- Carry scripted TCP input in `STEP.tcpInput` so headless scenarios can deliver commands at the exact tick without relying on loopback timing. See [P1-H](P1-H-firmware-bridge.md).
- Add optional `ScenarioResult.diagnostics` so assertion failures and undelivered commands can be reported alongside the original run end. Consider exposing `startupTimeoutMs` on the public firmware source options. See [P1-H](P1-H-firmware-bridge.md).
- Add `ControlApi.state()` for consumers that mount after connecting. Consider raw send and raw-line events on `ControlClient` so the desktop can remove its local relay. Improve HMR cleanup and defer formatting of hidden Network Console history. See [P1-F](P1-F-world-viewer.md).
- Tighten the World renderer tests for frame-loop restart and cone pixels. Review out-of-order track loads if track loading becomes asynchronous. See [P1-F](P1-F-world-viewer.md).
- Keep in-memory Workbench edits on a failed reload, cover same-project asynchronous races, clear recovered catalog errors, and reconcile simultaneous alerts. See [P1-E](P1-E-workbench.md).
- Set native PTY helper permissions at packaging time. Review external compiler diagnostic links, Finder/Dock shell locale, concurrent project opens, the Electron permission check handler and stale editor reloads. See [P1-D](P1-D-app-shell-terminal.md).
- Make HAL cache cleanup tolerate unrelated filesystem errors and active long builds, and use a deterministic full-backlog fixture for connection timeouts. See [P1-C](P1-C-hal.md).
- Extend sensor coverage for rotated IMU acceleration, distance sample duration, HC-SR04 pin detection and echo edge cases. Review voltage-divider battery selection and update rate, share gravity constants and reuse sensor test helpers. See [P1-B](P1-B-sensor-models.md).
- Forward test-runner shutdown to detached firmware tests, revisit watchdog granularity on slow hosts, document the first reconnect telemetry slot and define a separate ToF failure reading. Validate platform-specific firmware hardware builds when Phase 3 adds flashing. See [P1-G](P1-G-starter-firmware.md).
- Verify simulation determinism on Intel macOS. See [P1-A](P1-A-sim-core-physics.md).

## Beyond v1 (not scheduled)

Hardware-in-the-loop · `gym-donkeycar` protocol · Raspberry Pi brain · camera sensor · multiple cars · track editor · scripted part behaviors · visual wiring diagram · Windows · signed and notarized macOS app.
