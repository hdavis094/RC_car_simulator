# P1-G — Starter firmware

Status: in-review
Agent: Codex (gpt-6.1-sol)
Branch: ws/p1-g
Depends on: P1-C
Wave: 2

## Goal

The starter firmware that every new car project starts from. It's real ESP32 firmware that would drive the real car, and it is the firmware the v1 scenario runs.

## Owned paths

`packages/firmware-template/`

## Read first

`packages/control-protocol/SPEC.md`, the example `car.json` and its generated header in `packages/schema`, `packages/schema/README.md` (shimmed libraries), `packages/hal` README, PRD → Starter firmware.

## Requirements

1. **Project template**:
   - `platformio.ini` with env `esp32dev` (Arduino framework, core 3.x) and `lib_deps` pinned to the shimmed libraries plus ArduinoJson 7
   - `car.json` = the example car
   - `include/car_config.h` generated from it
   - `src/main.cpp`
2. **Boot**:
   - Serial at 115200 with a banner
   - VL53L0X XSHUT bring-up assigning target addresses
   - MPU6050 init
   - servo centred
   - ESC held at neutral through arming
   - Wi-Fi up, control server on port 3333
3. **Control protocol**:
   - parses `drive`, `mode` and `estop`
   - sends `hello` on connect and `telemetry` at 20 Hz
   - serves one client at a time; a new client replaces the old one
4. **Auto mode**: obstacle avoidance from the three ToF sensors. Cruise throttle, steer away from the nearer side, slow when the centre distance drops, stop and reverse-steer when blocked. Tuned so the v1 scenario passes; tuning constants live at the top of the file.
5. **Safety**:
   - manual mode with no `drive` for 500 ms → neutral throttle (failsafe)
   - `estop` latches neutral until a `mode` command
   - sensor timeout → treat as blocked
6. **Structure**: decision logic (avoidance, failsafe timer, command parsing) in small pure functions in separate files, so it can be unit-tested with doctest on the host without the sim.

## Acceptance

- [x] `pnpm verify` passes
- [x] doctest unit tests cover the avoidance decisions, failsafe timing and command parsing
- [x] builds with hal `build-sim` with zero warnings at `-Wall -Wextra`, with both GCC and Clang
- [x] runs against hal's fake sim for 2 s of sim time: arms the ESC, answers a `hello`, streams telemetry
- [x] if PlatformIO is installed, `pio run -e esp32dev` compiles; record the result (or "not available") in the Handoff

## Out of scope

The sim-side bridge (P1-H), tuning against the real sim (P2-01 retunes if needed), OTA updates.

## Handoff

- **Built**: Complete PlatformIO-compatible starter car project, with an exact copy of schema's example car and generated header; pinned Arduino-ESP32 3.2.1 platform, all three shimmed libraries and ArduinoJson 7.4.2. Boot initializes Serial, sequential XSHUT addressing, MPU6050, centred steering, 3 s neutral ESC arming and Wi-Fi/control server. Control supports bounded JSON-lines parsing, hello, 20 Hz telemetry, newest-client replacement, wrapped sequence ordering, manual drive, latched e-stop and the exact 500 ms failsafe. Auto mode cruises, steers away, slows, stops and reverse-steers; failed/timed-out sensors hold neutral. Pure command, control and avoidance functions are separated from Arduino I/O. README documents builds, Wi-Fi configuration and tuning.
- **Validation**: 12 doctest cases / 22,889 assertions pass with GCC 16.2.1 and Clang 23.1.3. HAL `build-sim` passes with `-Wall -Wextra -Werror` on both compilers. The built executable runs against HAL's fake sim for 5.1 s; tests observe neutral PWM through arming, subsequent auto/manual PWM, sensor telemetry at 20 Hz, hello, client replacement, sequence rejection, e-stop, failsafe, fragmented commands and overlong-line recovery. PlatformIO: **not available** (`pio` and `platformio` absent). Repository-wide `pnpm verify`: **passes**, including formatting, lint, typechecking, 312 Vitest tests, both compiler suites and all 7 Playwright tests. The scenario command reports its documented P2-01 placeholder.
- **Deviations from the brief**: The fake-sim run lasts 5.1 s rather than 2 s because the default ESC part requires 3 s at neutral before driving; this leaves over 2 s after arming. Firmware host checks run through this package's `typecheck` script so root verification includes them without modifying shared scripts. Sensor timeouts stop rather than reverse without trustworthy readings. The car name is a local constant matching the example; the existing generated header exposes pins and addresses but no name. When renaming a copied project, update `kCarName` too (documented in README).
- **Contract change requests**: None.
- **Open questions**: P2-01 still needs to tune the initial avoidance constants against the real v1 scenario (the current repository scenario command is a placeholder). Hardware compilation remains unverified because PlatformIO is unavailable; macOS runtime/Apple clang validation remains for CI. The desktop's current copy filter also copies the package's host tests/scripts into new car projects; they do not affect `build-sim` or `pio run`, but excluding development-only files is a possible desktop follow-up.
