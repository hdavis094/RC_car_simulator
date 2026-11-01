# Phase 3 — Backlog

The orchestrator writes full briefs from `_TEMPLATE.md` for these after the user approves the P2-01 demo. Suggested agents in brackets.

- **P3-01 PlatformIO flash + real serial monitor** [Codex]: detect or install PlatformIO on Linux and macOS, `pio run -e esp32dev -t upload`, and a serial port picker covering `/dev/ttyUSB*` and `/dev/ttyACM*` on Linux and `/dev/cu.*` on macOS. Note the CP210x/CH340 USB-serial driver for macOS. Bind the Serial Monitor to the real port.
- **P3-02 Network fault injection UI** [Antigravity]: a panel in the 3D World for latency, loss and dropout, sent to hal through `STEP` fault settings; a scenario proving the failsafe fires under dropout.
- **P3-03 Physics stage 2** [Claude]: tyre grip and slip, mass and CoG from placed parts, battery sag under load feeding the ADC reading, ESC brake/reverse double-tap.
- **P3-04 WebSocket transport for the control protocol** [Codex]: so a phone browser can drive the car.
- **P3-05 Packaged apps** [Codex]: electron-builder producing an AppImage for Linux and an unsigned `.dmg` for macOS (arm64 + x64). The app has to find a C++ compiler at run time and send the user to Xcode Command Line Tools if it's missing. Document Gatekeeper's first-launch step.
- **P3-06 Polish** [any]: recent projects, keyboard shortcuts, settings, error-message pass, first-run experience.

## Beyond v1 (not scheduled)

Hardware-in-the-loop · `gym-donkeycar` protocol · Raspberry Pi brain · camera sensor · multiple cars · track editor · scripted part behaviors · visual wiring diagram · Windows · signed and notarized macOS app.
