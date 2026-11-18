# P1-H — sim-core: firmware bridge

Status: in-review
Agent: Claude (Sonnet sub-agent)
Branch: ws/p1-h
Depends on: P1-A, P1-C
Wave: 2

## Goal

sim-core runs a real firmware process in lockstep. It serves sim-protocol, delivers sensor readings and GPIO edges into the firmware, and turns the firmware's PWM into actuator commands. This is where `sim-core` and `hal` meet.

## Owned paths

`packages/sim-core/src/bridge/`, and the `--firmware` and `--control` options of the scenario CLI in `packages/sim-core/src/scenario/` (P1-A has merged by then). Implement `CreateFirmwareSource` and `ActuatorSource.restart`.

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

- **Built**: `packages/sim-core/src/bridge/` (see its README).
  - `createFirmwareSource` / `FirmwareSource`: Unix socket server under `/tmp`, process spawn with `RCSIM_SOCKET`, HELLO/version check, CONFIG from the Run's device table, one STEP/STEP_DONE per tick (readings given their device index and ordered; Serial RX chunked to the 16 KiB protocol limit), 2 s wall stall timeout (`stalled`, BYE + SIGKILL), crash/exit (`crashed` with exit code, signal, last stderr lines, firmware BYE message), protocol violations (`error`), `restart()` (the next STEP carries the run's current tick; network faults are resent), `stop()` safe at any time including mid-step. An exit hook kills live firmware if the host dies, since a sketch that spins never notices its socket closing.
  - Streams (serial, log, net) are the Run's existing events, fed from `TickOutput`; nothing extra was needed on the bridge.
  - `--firmware <binary>` in the CLI: `runScenario` now builds the bridge itself when `io.createFirmwareSource` is absent (the hook stays for fakes); missing binary is exit 2 with a build-sim hint, a firmware failing before the first tick is exit 1. `--control <timeline.json>` (needs `--firmware`): `ControlledSource` wraps the firmware source and writes entries to the firmware's TCP server (found via its LISTEN event) just before the tick containing their time. Format: `{tUs, message | line, port?, everyMs?, untilUs?}`; `message` is checked against control-protocol's client schema, `everyMs` with `untilUs` repeats (a repeated `drive` raises `seq`). Documented in the README and `--help`.
  - Tests build real sketches (`bridge/fixtures/*/main.cpp`) with `build-sim`, plus JS fake firmwares for protocol misbehaviour. All six acceptance items are covered: servo sweep vs steering angle within the slew limit, `millis()` print exactly 1 000 000 µs apart, `spin` stalled in ~2 s wall, `abort()` crashed with `SIGABRT`, same seed gives identical serial output and snapshot hashes. Also covered: restart, Serial RX, sensor reading to device mapping, HC-SR04 GPIO write/edge round trip, control timeline (also through the CLI), stop mid-step, socket cleanup. Passes with GCC 16 and clang 23 (`CXX=clang++`); macOS untested here.
  - `pnpm verify` passes.
- **Deviations from the brief**:
  - Added `@rcsim/control-protocol` (workspace) to sim-core's dependencies for `--control` validation, so `pnpm-lock.yaml` changed.
  - Edited P1-A's `scenario/runner.ts` and `cli.ts` (the `--firmware`/`--control` wiring, usage text, startup-failure handling) and one case in `scenario/cli.test.ts` whose expected message changed (`--firmware` with a missing binary no longer says "needs the firmware bridge").
  - Serial RX beyond hal's own 16 KiB queue is dropped by hal (by design in hal); the bridge only guarantees order and the protocol limit. Noted in the README.
  - The sketches in `bridge/fixtures/` are test fixtures, not the starter firmware (P1-G).
- **Contract change requests**:
  1. **Export the bridge from `packages/sim-core/src/index.ts`** (not mine to edit): add `export { createFirmwareSource, FirmwareSource, parseControlScript, withControlScript, ControlScriptError, ControlledSource, type ControlEntry } from './bridge/index.ts';`. Without it P2-01 cannot import the bridge (the package exports only `.`, `./api`, `./stubs`).
  2. Optional, for the app's Network Console: `ScenarioResult` has no serial output, so a CLI scenario can't assert on what the firmware printed. A `serial` field (or an `--assert-serial` style option) would need an `api/scenario.ts` change; the tests read serial through `Run`'s `serial` event instead.
- **Open questions**:
  - Packaging (P2-01): the bridge spawns whatever binary it is given, so nothing here depends on Node being on PATH, but `build-sim`'s `#!/usr/bin/env node` and cache location are the hal-side issues the hal README already lists.
  - `ControlledSource` waits indefinitely for a port that never listens; the entries stay in `pending`. Whether the CLI should fail a scenario that ends with control lines unsent is a product call (currently it does not).
