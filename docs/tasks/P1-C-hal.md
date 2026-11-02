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
  - 36 doctest cases / 1,914 assertions pass with GCC 16.2.1 and Clang 23.1.3 under `-Wall -Wextra -Wpedantic -Werror`. Includes a real built firmware process driven by a C++ fake sim for 400 ticks, TCP JSON exchange, precise delay/busy-wait/pulse tests, three-sensor XSHUT sequencing, network faults, compile errors, socket loss and socket-path limits.
  - Final `pnpm verify` passed: formatting, lint, typecheck, 273 TypeScript tests, both HAL compiler runs, scenario command and Electron smoke test.
- **Deviations from the brief**:
  - The process integration fixture is under `packages/hal/test/fixtures/firmware/`; the starter firmware is still the P0 scaffold and belongs to P1-G. No files in that package were changed.
  - ADC uses a linear 12-bit 0–3.3 V conversion, without hardware calibration/nonlinearity. Network destinations support numeric IPv4 and `localhost`; DNS, IPv6 and radio/authentication behaviour are not modelled. Injected TCP segment loss discards bytes at the HAL boundary without simulating TCP retransmission. These limits are documented in `packages/hal/README.md`.
- **Contract change requests**: None.
- **Open questions**: None blocking. Apple clang and macOS runtime portability still need macOS CI. The repository scenario command currently passes through its P0 placeholder; the complete v1 vehicle scenario remains P2-01 work.

- **macOS CI** (run 41529553473, head `04e6e5f`):
  - Cause: the Wi-Fi tests assumed a successful peer `send` meant the receiving socket was already readable. TCP's first `available()` returned zero while the following peek/read succeeded. UDP's injected latency starts when HAL receives the datagram, so spending 2 ms of sim time immediately after peer send could expire before macOS delivered it; the failed receive then left no valid reply peer and caused the reply timeout.
  - Fix: bounded, EINTR-aware `poll` barriers on borrowed native descriptors, without fixed sleeps or wall-clock waits inside HAL. TCP waits for the full expected byte count; UDP waits for kernel readability before measuring the configured sim-time latency, loss and dropout. Added observation-only `fd()` accessors and made the UDP receive a prerequisite for the reply assertions.
  - BSD audit: created and accepted sockets already set `O_NONBLOCK`/`FD_CLOEXEC` explicitly and use `SO_NOSIGPIPE` where supported; firmware ignores SIGPIPE before opening sockets and does not depend on Linux `MSG_NOSIGNAL`. New checks inspect socket flags/options on listeners, accepted clients, outgoing clients and UDP. Pending connects retain the descriptor until `getpeername` confirms completion; tests now poll writability before asserting completion. XNU copies the supplied sockaddr length into `sa_len`, so a zero-initialized `sin_len` is not this failure. Empty nonblocking TCP/UDP receives remain retryable and are exercised before later successful delivery.
  - Validation: 100 consecutive focused Wi-Fi runs passed; full `pnpm verify` passed locally, including 23 HAL cases / 1,739 assertions with each of GCC and Clang. macOS execution remains for CI; no local macOS result is claimed. Status remains in-review.

- **Review round 1**:
  - XSHUT release now honours the Pololu OUTPUT/LOW → INPUT (or INPUT_PULLUP) sequence, including the carrier pull-up and distinct sensor re-addressing. `shims_test.cpp` covers both release modes and all three readings.
  - Added Printable/IPAddress printing and length-delimited character writes, numeric String `+=`/`concat`, String edits, Stream `parseInt`/`readString`, two-argument Serial `begin`, seeded Arduino random functions, analog PWM/ADC resolution, math helpers/constants and common-type `constrain`. Explicit Serial/client bool conversions are retained and checked at compile time. `compatibility_test.cpp` covers the added APIs and deterministic reseeding; the TCP test also writes a character buffer to a real peer.
  - Server CONNECT/DISCONNECT events now apply only to accepted clients. Outbound `connect()` resolves success/refusal before returning using a bounded, EINTR-aware host `poll` (one second maximum), without spending sim time beyond the normal HAL call cost. `wifi_test.cpp` checks refusal, successful connection, clock cost and explicit/RAII outbound closes. Client `fd()` remains; simulator-only server/UDP descriptors and mapped ports moved to `rcsim::hal::socketFd`/`hostPort` in `rcsim/network.h`, with compile-time checks that the Arduino-facing classes no longer expose them.
  - LEDC pulse conversion rounds to nearest; the 50 Hz / 16-bit neutral regression now expects 1500 µs. Serial accumulation keeps a count and protocol array traversal is linear. `runtime_test.cpp` reproduced the old 16 KiB performance failure, then passed with the linear implementation (the full serial regression takes about 2 ms locally, with a 250 ms guard), while checking exact bytes and overflow into the following tick.
  - An `atexit` hook sends BYE(firmware-exit), with its descriptor cleared on the ordinary return/error paths. Integration tests call `exit(7)` from setup and loop, verify exactly one BYE with reason 5, and preserve the exit code.
  - Firmware library builds allow compiler warnings; HAL's own tests continue to compile the library and tests under `-Werror`. `build-sim` accepts compiler/launcher words and quoted paths without evaluating shell expansions. Its cache is content-addressed by compiler command/version, flags and HAL inputs, built privately and published by atomic directory rename. Integration tests use a launcher that rejects `-Werror`, a quoted path containing spaces and metacharacters, and concurrent cold builds that must produce both executables and exactly one complete shared cache entry with no temporary directory left over.
  - Servo defaults are unchanged: ESP32Servo **3.2.1** defines `DEFAULT_uS_LOW = 544` and `DEFAULT_uS_HIGH = 2400`, and `attach(pin)` passes those values. The 500/2500 constants are allowed limits, not defaults. Sources: [header](https://github.com/madhephaestus/ESP32Servo/blob/3.2.1/src/ESP32Servo.h#L80-L104), [attach implementation](https://github.com/madhephaestus/ESP32Servo/blob/3.2.1/src/ESP32Servo.cpp#L71-L74). `shims_test.cpp` pins the resulting 544/1472/2400 µs outputs at 0/90/180 degrees.
  - **P2-01 / packaging**: `#!/usr/bin/env node` still needs Node on PATH, which a Finder-launched macOS app lacks. Packaging must provide an explicit runtime and relocate the package-local build cache to a writable app cache, since bundled package files are read-only. `build-sim` does not call `process.chdir`: it spawns Make with cwd set to the HAL package and the firmware compiler with cwd set to the car project. Firmware source arguments are absolute; relative firmware diagnostics resolve against the project directory as P1-D expects. Relative internal HAL diagnostics from Make resolve against the HAL package.
  - Validation: final `pnpm verify` passed, including 36 HAL cases / 1,914 assertions with both GCC and Clang under strict warnings, 273 TypeScript tests and Electron smoke coverage. Each requested fix has regression coverage under `packages/hal/test/`.
  - No contract changes. Status remains in-review. macOS CI was green at baseline `9b221f4`; these review changes still need the next macOS CI run.
