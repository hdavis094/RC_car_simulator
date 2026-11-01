# P1-H — sim-core: firmware bridge

Status: todo
Agent: Claude (Sonnet sub-agent)
Branch: ws/p1-h
Depends on: P1-A, P1-C
Wave: 2

## Goal

sim-core runs a real firmware process in lockstep. It serves sim-protocol, delivers sensor readings and GPIO edges into the firmware, and turns the firmware's PWM into actuator commands. This is where `sim-core` and `hal` meet.

## Owned paths

`packages/sim-core/src/bridge/`

## Read first

`packages/sim-protocol/SPEC.md` and the TS codec, `packages/sim-core/src/api/` (`ActuatorSource`, `SensorModel`, `Run`), `packages/hal` README (build-sim, sample sketches), ADR 0003.

## Requirements

1. **Firmware `ActuatorSource`**:
   - creates the Unix socket and spawns the firmware binary with `RCSIM_SOCKET` set
   - handles HELLO and version checks
   - sends CONFIG built from `car.json` + catalog: the device table and pin-to-part map
2. **Each tick**:
   - sends STEP carrying the readings the sensor models produced since the last step, scheduled GPIO edges (HC-SR04 echoes), serial RX and fault settings
   - awaits STEP_DONE
   - maps PWM pins to actuator models
   - routes GPIO writes (HC-SR04 triggers) to the right sensor models
3. **Streams**: serial TX/RX, debug log and net events (listen-port mappings), exposed on `Run` for the app.
4. **Failure handling**:
   - **stall**: no STEP_DONE within 2 s wall → the run ends with `stalled`
   - **crash or exit**: the run ends with `crashed`, including the exit code/signal and the last stderr lines
   - **reboot** support: restart the process while the world continues
5. **Scenario CLI**: `rcsim run --firmware <binary>` (P1-A's CLI gains the flag). Add scripted control-protocol input: `--control <timeline.json>`, sent to the firmware's mapped port at given sim times.
6. Use sensor models through the `SensorModel` interface. Use the api stubs for any template P1-B hasn't merged yet.

## Acceptance

- [ ] `pnpm verify` passes
- [ ] with a hal sample sketch built by `build-sim`: a sketch sweeping the servo makes the vehicle steering angle follow the sweep (within the slew limit)
- [ ] a sketch printing `millis()` once per second produces exactly 1000-ms spacing in sim time
- [ ] a sketch that spins forever without hal calls ends as `stalled` within 3 s wall
- [ ] a sketch that calls `abort()` ends as `crashed` with the signal reported
- [ ] two runs with the same seed and firmware produce identical serial output and snapshot hashes

## Out of scope

The app-side SimService (P2-01), sensor model internals (P1-B).

## Handoff

- **Built**:
- **Deviations from the brief**:
- **Contract change requests**:
- **Open questions**:
