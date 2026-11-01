# P1-C — hal: Arduino/ESP32 layer for desktop builds

Status: todo
Agent: Codex (gpt-6.1-sol)
Branch: ws/p1-c
Depends on: P0 (all)
Wave: 1

## Goal

The starter firmware and similar sketches compile unchanged with g++ against hal, run in lockstep with the sim over sim-protocol, and see sensors, PWM, serial and Wi-Fi as if on an ESP32.

## Owned paths

`packages/hal/`

## Read first

`packages/sim-protocol/SPEC.md` and `vectors/`, `packages/control-protocol/SPEC.md`, `packages/schema/README.md` (shimmed library list), ADRs 0001–0003, ARCHITECTURE.md → Lockstep time, Sensors and actuators, Wi-Fi, Builds.

## Requirements

1. **Core API** (`Arduino.h`):
   - `pinMode`, `digitalRead/Write`
   - `analogRead` (ADC readings from STEP), `analogReadMilliVolts`
   - `millis`, `micros`, `delay`, `delayMicroseconds`, `pulseIn`, `yield`
   - `Serial` (`HardwareSerial`: `begin/print/println/printf/available/read`)
   - `String`, `constrain`, `map`
   - ESP32 LEDC: `ledcAttach`/`ledcWrite` (Arduino-ESP32 core 3.x names)
2. **Lockstep runtime**: the virtual clock with the time-cost model from CONFIG, the STEP / STEP_DONE exchange at tick boundaries, and `setup()` then a `loop()` cycle. Handle socket loss cleanly by exiting with a message.
3. **`Wire`** for shimmed devices: the address-routing surface shims need, and `begin(sda, scl)` checked against car config.
4. **Library shims**:
   - `ESP32Servo` (attach, `write`, `writeMicroseconds`)
   - `pololu/VL53L0X` (`init`, `setAddress`, `setTimeout`, `startContinuous`, `readRangeContinuousMillimeters`, `timeoutOccurred`), modelling the 0x29 boot address, XSHUT gating and per-instance addresses
   - the MPU6050 library chosen in P0-03 (its common API surface)
5. **Portable libraries**: vendor ArduinoJson 7 (header-only, runs natively) under `libraries/` and put it on the sim-build include path, so firmware uses the same library in both builds.
6. **Wi-Fi**: `WiFi.begin/status/localIP`, `WiFiServer`, `WiFiClient`, `WiFiUDP` on non-blocking POSIX sockets. Remap listen ports and report the mapping as a net event. Apply fault injection settings from STEP.
7. **Build driver** `bin/build-sim <project-dir>`:
   - compiles `src/*.cpp` with hal includes first and links the cached prebuilt hal
   - outputs `.rcsim/build/firmware`
   - passes g++ diagnostics through unchanged
   - exit code reflects success
8. **Tests**:
   - doctest for each API area
   - the protocol codec replays every golden vector byte-identically
   - a C++ fake sim drives a sample sketch through a few hundred ticks

## Acceptance

- [ ] `pnpm verify` passes
- [ ] every `sim-protocol/vectors/` file decodes and re-encodes byte-identically in C++
- [ ] `delay(100)` in `loop()` advances sim time by exactly 100 ms per iteration (plus the configured call cost)
- [ ] a busy-wait `while (millis() - t < 50) {}` terminates
- [ ] three VL53L0X instances brought up with the XSHUT sequence get distinct addresses, and read distinct fake-sim readings
- [ ] a `WiFiServer` on port 3333 is reachable on the reported host port from a test client
- [ ] a sketch with a compile error yields g++'s `file:line:col: error:` output and a non-zero exit from `build-sim`

## Out of scope

FreeRTOS tasks, `attachInterrupt`, BLE, the sim-side bridge (P1-H), PlatformIO real builds.

## Handoff

- **Built**:
- **Deviations from the brief**:
- **Contract change requests**:
- **Open questions**:
