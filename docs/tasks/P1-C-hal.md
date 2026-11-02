# P1-C — hal: Arduino/ESP32 layer for desktop builds

Status: in-review
Agent: Codex (gpt-6.1-sol)
Branch: ws/p1-c
Depends on: P0 (all)
Wave: 1

## Goal

The starter firmware and similar sketches compile unchanged with the system C++ compiler against hal on Linux and macOS, run in lockstep with the sim over sim-protocol, and see sensors, PWM, serial and Wi-Fi as if on an ESP32.

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
   - uses `$CXX`, else `c++`
   - passes compiler diagnostics through unchanged
   - exit code reflects success
8. **Tests**:
   - doctest for each API area
   - the protocol codec replays every golden vector byte-identically
   - a C++ fake sim drives a sample sketch through a few hundred ticks

## Acceptance

- [x] `pnpm verify` passes
- [x] every `sim-protocol/vectors/` file decodes and re-encodes byte-identically in C++
- [x] `delay(100)` in `loop()` advances sim time by exactly 100 ms per iteration (plus the configured call cost)
- [x] a busy-wait `while (millis() - t < 50) {}` terminates
- [x] three VL53L0X instances brought up with the XSHUT sequence get distinct addresses, and read distinct fake-sim readings
- [x] a `WiFiServer` on port 3333 is reachable on the reported host port from a test client
- [x] a sketch with a compile error yields the compiler's `file:line:col: error:` output and a non-zero exit from `build-sim`
- [x] hal and its tests build warning-free at `-Wall -Wextra` with both GCC and Clang
- [x] socket paths stay under 100 bytes, checked by a test

## Out of scope

FreeRTOS tasks, `attachInterrupt`, BLE, the sim-side bridge (P1-H), PlatformIO real builds.

## Handoff

- **Built**:
  - Arduino/ESP32 core surface, serial/Print/Stream/String helpers, GPIO/ADC/LEDC, and Servo, Wire, VL53L0X and Electronic Cats MPU6050 shims.
  - Nanosecond lockstep runtime with carried advances, boot-relative uptime, timestamped GPIO edges, CONFIG/STEP validation, framed Unix socket transport, clean BYE handling and socket-loss diagnostics.
  - C++ sim-protocol codec: all 17 valid vectors match their JSON and round-trip byte-identically in both directions; all 16 malformed vectors are rejected.
  - Nonblocking IPv4 TCP/UDP sockets with ephemeral host-port mappings, connection lifecycle events, bounded queues, sim-time latency, seeded loss and dropout.
  - Vendored unmodified ArduinoJson 7.4.2 single header and MIT licence; Arduino String input/output/conversion compatibility is covered.
  - Executable `packages/hal/bin/build-sim`, compiler-aware static-library cache, HAL-first includes, project paths containing spaces/quotes/metacharacters, and unchanged compiler diagnostics/exit status.
  - 23 doctest cases / 1,707 assertions pass with GCC 16.2.1 and Clang 23.1.3 under `-Wall -Wextra -Wpedantic -Werror`. Includes a real built firmware process driven by a C++ fake sim for 400 ticks, TCP JSON exchange, precise delay/busy-wait/pulse tests, three-sensor XSHUT sequencing, network faults, compile errors, socket loss and socket-path limits.
  - Final `pnpm verify` passed: formatting, lint, typecheck, 272 TypeScript tests, both HAL compiler runs, scenario command and Electron smoke test.
- **Deviations from the brief**:
  - The process integration fixture is under `packages/hal/test/fixtures/firmware/`; the starter firmware is still the P0 scaffold and belongs to P1-G. No files in that package were changed.
  - ADC uses a linear 12-bit 0–3.3 V conversion, without hardware calibration/nonlinearity. Network destinations support numeric IPv4 and `localhost`; DNS, IPv6 and radio/authentication behaviour are not modelled. Injected TCP segment loss discards bytes at the HAL boundary without simulating TCP retransmission. These limits are documented in `packages/hal/README.md`.
- **Contract change requests**: None.
- **Open questions**: None blocking. Apple clang and macOS runtime portability still need macOS CI. The repository scenario command currently passes through its P0 placeholder; the complete v1 vehicle scenario remains P2-01 work.
