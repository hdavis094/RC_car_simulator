# P1-G — Starter firmware

Status: todo
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

- [ ] `pnpm verify` passes
- [ ] doctest unit tests cover the avoidance decisions, failsafe timing and command parsing
- [ ] builds with hal `build-sim` with zero warnings at `-Wall -Wextra`
- [ ] runs against hal's fake sim for 2 s of sim time: arms the ESC, answers a `hello`, streams telemetry
- [ ] if PlatformIO is installed, `pio run -e esp32dev` compiles; record the result (or "not available") in the Handoff

## Out of scope

The sim-side bridge (P1-H), tuning against the real sim (P2-01 retunes if needed), OTA updates.

## Handoff

- **Built**:
- **Deviations from the brief**:
- **Contract change requests**:
- **Open questions**:
