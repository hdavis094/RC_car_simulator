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

### Review round 1

All nine items fixed in one commit on `ws/p1-h`; `pnpm verify` passes. The regression tests are in `bridge/review-round-1.test.ts` (plus `fake-firmware.ts`, `fixtures/host.ts`, `fixtures/pwm-once/`). I ran them against the code of `3d766a3` (with minimal shims for the new accessors): every item's test fails there, except where noted below.

1. **Leak.** `#wait` no longer races long-lived promises. The process-exit and stop reactions are attached once per process and wake a single slot for the wait in progress. Test: reactions attached to the process's `exit` promise over 3000 ticks stay under 10 (was one per tick).
2. **Control deadlock.** `ControlledSource` queues writes and never awaits them. The first connection to a port is still awaited, under a stall timeout (`ControlledSource` takes `stallTimeoutMs`, default 2000). Test: 2000 × 4000-byte lines at `tUs` 1000 into the control sketch, firmware stall timeout 100 ms: 60 ticks complete (hung before).
3. **Reboot PWM.** `restart()` remembers the pins the old firmware drove (from its STEP_DONEs); the next tick's `pwm` starts with `periodUs: 0` for each, then the new firmware's own output. Test: an armed ESC at `motorDuty > 0` is 0 after `restartFirmware()` when the new firmware attaches nothing.
4. **Stop during start.** `stop()` now waits for `start()`, which checks for the stop after each await and before spawning; cleanup runs after it settles. Test: `stop()` in the same breath as `start()`, and after 50 ms, leaves no socket file and no process. (The 50 ms case passed before as well; the 0 ms case is the one that leaked.)
5. **Host signals.** Library: `killAllFirmware()` (kills processes and removes their sockets) and `installTerminationHandlers()` exported from `bridge/`; the only caller of the latter is `scenario/bin.ts`. The `exit` hook stays (changes no exit behaviour). README has a "When the host goes away" section for the desktop app. SIGKILL of the host remains unsurvivable for a spinning firmware; documented. Tests: a host process (`fixtures/host.ts`) with a spinning firmware is SIGTERMed and the firmware is gone and its socket file removed; `killAllFirmware()` in-process.
6. **Early STEP_DONE.** `Channel` takes an `accept` check that the source runs as each message is decoded: `HELLO` only first, `STEP_DONE` only for the outstanding unanswered tick, `BYE` always. A violation sends `BYE(malformed)` and ends the run `{kind:'error'}`. This also moves a malformed frame from `crashed` to `error` (SPEC.md), so two existing assertions in `protocol-errors.test.ts` changed. Tests: ten STEP_DONEs sent with HELLO; a duplicate; a tick not yet sent. A duplicate is noticed at the next tick (the first answer was valid), so that test allows one tick.
7. **seq wrap.** `(seq + n) % 2³²`.
8. **Timing.** An entry goes out at the first tick start with `t0Us >= tUs`, never before. Documented in the README and the `ControlledSource` doc; test pins 1000, 100 900 and 101 000 µs.
9. **Unsent entries.** `runScenario` fails the scenario when the `ControlledSource` still has entries after the run: `passed: false`, `end: {kind:'error', message}` (a run that already failed keeps its own end), CLI exit 1. The message names each entry's `tUs` and port and whether the port never listened or the run ended first (first five, then a count).
   - **Contract change request (optional, smallest shape):** `ScenarioResult.diagnostics?: readonly string[]`. Then a scenario could fail with its own end intact and several reasons at once. Until then the failure rides on `end`.
   - Side effect: entries whose `tUs` is at or after the scenario's last tick start also count as unsent.

Also: `killAllFirmware()` removes the sockets of live sources, because a SIGTERMed host otherwise left its socket file behind (found while writing the item-5 test).

### Review round 2

All five items fixed; `pnpm verify` passes. Regression tests are in `bridge/review-round-2.test.ts` (and `review-round-1.test.ts`, whose control-deadlock test changed with item 1). They fail on `8302002`: 8 of the 9 new or changed tests (the ninth, delivering 8 × 4000-byte lines per tick for three ticks, passes both ways by design). I also ran the repro scripts in `/tmp/p1h-review2/`: `double-restart`, `decoded-bypass`, `small-socket.mjs step-write` (SO_SNDBUF 4096), `queued-unsent.mjs` and `control-memory.mjs` now give the intended results (`control-loss.mjs` and `control-load.mjs` push megabytes per tick, so they now end with the bound error).

1. **Control determinism.** `ControlledSource` writes the entries due for a tick (grouped per port, in time order), waits for the writes to complete, then sends the STEP. At most 32 KiB (`MAX_CONTROL_BYTES_PER_TICK`) may be due per tick: more ends the run `error` ("control input for tick N exceeds 32768 bytes ...") before a byte is written (also fixes the 156 MB queueing). A write that doesn't complete within the stall timeout is an `error` ("did not drain ... not reading"). Test: ten runs with `lossPpm: 100000`, every control write delayed by a random 0–11 ms (a loaded kernel), give one serial hash; on `8302002` they give several.
   - **What this relies on, and what I could not establish.** On loopback TCP a completed `write` means the segment is on the peer's receive queue (Linux: delivery runs in the sender's softirq as it leaves the syscall; macOS: loopback input is processed in the sender's context). That is how both behave, not a POSIX guarantee; a delivery deferred to ksoftirqd under extreme load could land late, and I have not verified macOS behaviour. CI's macOS run is the only evidence. I found no handshake that confirms receipt without the firmware running (Node cannot read TCP_INFO/SIOCOUTQ/SO_NWRITE, and hal only reads its sockets while stepping).
   - **Contract change request (the guarantee that needs no kernel cooperation):** a `STEP` field `tcpInput: array<{ firmwarePort: u16, bytes: bytes }>` that hal appends to the matching accepted connection's receive queue at the start of the step, instead of the sim connecting from outside. That removes the kernel from the determinism argument and the 32 KiB bound along with it. Decide it with P2-01 together with `ScenarioResult.diagnostics`.
2. **Double restart.** The pending reset set is now the union of what is still unreported and what was active.
3. **Decoded frames before a malformed one.** `Channel` judges every decoded frame with `accept` in order; the first violation ends the connection. A malformed frame queued right behind a tick's answer ends the run at that tick (the tick's outputs are discarded), so the reviewer's case now completes 0 ticks.
4. **Backpressure.** The STEP write and the wait for its STEP_DONE are one wait under one stall timer (the CONFIG write is under it too). `stop()` starts the 500 ms kill deadline first and sends BYE without waiting (so do the stall and version-mismatch paths). Tests hold the bridge's socket writes pending, as a full buffer does: the step ends `stalled` in 100 ms; `stop()` returns in under 2 s with the process gone and the socket removed.
5. **Delivered means drained.** An entry is marked delivered only when its write has completed; a failed write (firmware dropped the connection) leaves it pending and it is retried over a new connection. Together with item 1 nothing is left buffered and uncounted: the reviewer's 2000 × 4000-byte scenario now exits 1 with the bound error.

### Review round 3

All three items fixed; `pnpm verify` passes. Regression tests are in `bridge/review-round-3.test.ts` (and `review-round-2.test.ts`, whose decoded-bypass test now expects 1 tick, see item 2). Six of the seven new tests fail on `0511820`; the "byte by byte, over time" chunking case passes there too, because the bad frame then arrives after the tick completed, which is the correct result. I also ran `/tmp/p1h-review3/`: `retry-partial.mjs` now ends with the "delivery ambiguous" error and one connection, `frame-boundary.mjs` gives the same result for both splits, `stop-connect.mjs` stops in 3 ms.

1. **No retries.** Any failed write on a control connection ends the run `error`: "control connection to port P reset during tick N; delivery ambiguous (...none are resent)". The reconnect-and-retry path is gone, and after such a failure the source refuses further steps (so a caller that steps again cannot replay either). The failed batch's entries stay undelivered. Entries for a port that never listened are unchanged (the scenario fails at the end, round 1 item 9). A connection the firmware had already closed *before* a write is still reopened for that write, since nothing was in doubt. Test: a write that delivers ten of 300 lines and then fails with ECONNRESET leaves exactly those ten on one connection, no second connection, nothing counted delivered.
2. **Chunking independence.** I had read your round 2 wording as "discard the tick", and that was wrong. Removed the peek: frames are applied one at a time in wire order. A valid `STEP_DONE` completes its tick and its outputs stand; the first invalid frame gets `BYE(malformed)`, nothing before it is rolled back and nothing after it is processed, and the run ends at the next tick's wait. `Run.step(n)` sees that end as soon as a later tick is stepped; with `step(1)` the end isn't visible until the next step, in every chunking. Test: one valid tick with serial output followed by a bad frame, in one write, delivered to the bridge as one chunk, byte by byte (at once and spread over time), and in seeded random splits (at once and spread over time): identical `ticks` 1, clock 1000 µs, serial `['valid tick\n']` and end `error` ("unknown message type").
3. **Stop during connection setup.** The connection promise now also settles on `close`: a stop gives `{kind:'finished'}`, any other close before connecting an `error`. Test: a connection that never completes, stall timeout 5000 ms, `stop()` after 50 ms: the step ends in well under 1.5 s (took the full timeout before).

