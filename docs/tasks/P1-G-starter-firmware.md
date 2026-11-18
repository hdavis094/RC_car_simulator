# P1-G — Starter firmware

Status: done
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
- **Validation**: 27 doctest cases pass with GCC 16.2.1 and Clang 23.1.3. HAL `build-sim` passes with `-Wall -Wextra -Werror` on both compilers. The built executable runs against HAL's fake sim for 5.1 s; tests observe neutral PWM through arming, subsequent auto/manual PWM, sensor telemetry at 20 Hz, hello, client replacement, sequence rejection, e-stop, failsafe, fragmented commands and overlong-line recovery. PlatformIO: **not available** (`pio` and `platformio` absent). Repository-wide `pnpm verify`: **passes**, including formatting, lint, typechecking, 460 Vitest tests, both compiler suites and all 7 Playwright tests. The scenario command reports its documented P2-01 placeholder.
- **Deviations from the brief**: The fake-sim run lasts 5.1 s rather than 2 s because the default ESC part requires 3 s at neutral before driving; this leaves over 2 s after arming. Firmware host checks run through this package's `typecheck` script so root verification includes them without modifying shared scripts. Sensor timeouts stop rather than reverse without trustworthy readings. The car name is a local constant matching the example; the existing generated header exposes pins and addresses but no name. When renaming a copied project, update `kCarName` too (documented in README).
- **Contract change requests**: Resolved by `addc31c` on main: HAL now mirrors `int HardwareSerial::availableForWrite(void)`, reporting remaining bytes in the current 16 KiB serial TX frame and charging its normal call cost. This behavior is correct for the starter firmware. Both targets take the capacity path; the host fallback remains only for older HAL revisions. No further HAL changes are requested. The existing `WiFiClient::fd() const` remains sufficient for nonblocking network sends; NetworkClient's inherited `availableForWrite()` still returns Print's default 0.
- **Open questions**: P2-01 still needs to tune the initial avoidance constants against the real v1 scenario (the current repository scenario command is a placeholder). Hardware compilation remains unverified because PlatformIO is unavailable; macOS runtime/Apple clang validation remains for CI. The desktop's current copy filter also copies the package's host tests/scripts into new car projects; they do not affect `build-sim` or `pio run`, but excluding development-only files is a possible desktop follow-up.

### Review round 1

- Replaced streaming JSON/println writes with a bounded 512-byte line, serialized once. Board sends use zero-time `select` plus one `send(MSG_DONTWAIT)` through `client.fd()`, bypassing NetworkClient's fixed 1 s / 10-retry write loop. The maximum line is checked against the SDK's `TCP_SNDLOWAT`: with one writer, lwIP writable readiness means the complete line fits. Backpressure drops the whole unsent line. Defensive short writes disconnect instead of concatenating an incomplete line with a new message. HAL builds keep the existing nonblocking queue fallback and sim fault injection. Optional abortive close is configured only when the SDK enables SO_LINGER; the send guarantee does not depend on that option.
- `writeOutputs()` now runs at the start of every loop and before every outbound attempt, applying the current failsafe/e-stop first. Regression tests fill a real host socket, verify no prefix is sent while full, check output-before-send ordering, exercise the exact 500 ms failsafe and e-stop despite congestion, and confirm normal sends recover after draining it. Comments cite pinned Arduino-ESP32 3.2.1 and ESP-IDF 5.4.2's lwIP sources, including the fixed retries, Print default, fd access and readiness threshold.
- E-stop and every mode command clear the stored manual command and recent-drive marker; only a fresh accepted drive resumes manual motion. Failsafe-trip and ESC-armed states latch through uptime wrap. Boot has no failsafe log before a drive. Added regression tests for stale-command resurrection, a full millis cycle and arming wrap.
- Avoidance tuning uses named C++17 field assignments, with blocked entry at 250 mm and exit above 325 mm; jitter tests cover hysteresis. Serial reports Wi-Fi status every second and points unconnected users to SSID/password configuration (`change-me` is a placeholder). Battery telemetry uses `analogReadMilliVolts()`, available in both targets. README identifies `scripts/`, `test/` and `package.json` as development-only; desktop copy filtering remains the requested P1-D follow-up.
- Validation: 18 doctest cases / 23,970 assertions pass on GCC and Clang, including the built 5.1 s fake-sim run and warning-free HAL builds. Full `pnpm verify` **passes**, including all 312 Vitest tests, both compiler suites and all 7 Playwright tests. PlatformIO remains **not available**. Status stays **in-review**; no rebase or push.

### Review round 2

- Reproduced the actual logging amplification before the fix: the built-firmware fake-sim test sent 256 empty lines, an e-stop, then more junk, and captured **42,240 Serial bytes** instead of the 128-byte test ceiling. `pnpm --filter @rcsim/firmware-template test` failed on that assertion before the production change.
- Coalesced rejected invalid/overlong lines into one summary at most every 1000 ms, on Serial and the network. Each `serviceControl` slice handles at most 8 lines / 256 bytes, with sensor/avoidance/output work between slices and an outer-loop cap of 4096 input bytes. The shared scheduler/parser test verifies that e-stop following 256 junk lines applies in the same outer loop, after 32 control updates, with trailing flood data still unread. The built-firmware flood regression now stays below the Serial-byte ceiling.
- All Serial lines now use a whole-line capacity check (CRLF included) and one write; insufficient UART space skips the message. Arduino-ESP32 3.2.1 supports the required `int HardwareSerial::availableForWrite(void)`; HAL does not, so the exact contract request and local host fallback are recorded above. No HAL edit, rebase or push.
- Temporary socket `ENOMEM`/`ENOBUFS` errors drop the unsent line. Added tests for actual peer closure/EPIPE and negative/out-of-range descriptors. Hello retries after backpressure on later outer loops, remains the first complete network message and stops retrying after success. The congested-socket test now allows 1 s of host scheduling time for loaded macOS runners.
- Validation: **`pnpm verify` passes**, including 24 doctest cases / 25,040 assertions on each of GCC and Clang, warning-free HAL builds, the 5.1 s built-firmware fake-sim run, 460 Vitest tests, both HAL compiler suites and all 7 Playwright tests. Status remains **in-review**. PlatformIO remains **not available**.

### macOS CI

- Investigated the reported macOS timeout in run 44381163771. The old log did not identify the active case, and this Linux host cannot reproduce the exact Apple-clang runner state. Found a definite hang path in the congested-socket test: a nonfatal failed hello-send check was followed by a blocking `recv`, which waited forever if no hello arrived. Both filling until EAGAIN and draining until empty were also unbounded. These paths are fixed; the original macOS trigger remains an inference until CI runs again.
- Host binaries now run with `--duration=true` and a doctest listener that flushes RUN/DONE case names immediately. A 60 s per-process watchdog reports the current/last case and SIGKILLs the entire POSIX process group, including forked firmware. Three Node tests cover success, nonzero exit with case attribution, and a deliberately hung parent/child pair; the timeout test confirms descendants cannot keep the pipes open.
- Congestion tests set both send/receive buffers small, configure macOS's send low-water mark explicitly, cap filling at 1 MiB / 1024 attempts and drain only the recorded byte count with a finite attempt cap. A missing hello is now a fatal assertion before a nonblocking receive. All test sockets, including accepted fake-sim descriptors, use O_NONBLOCK; partial framed reads/writes and connects have explicit deadlines. Receive collection is bounded, and sends use MSG_DONTWAIT plus MSG_NOSIGNAL or SO_NOSIGPIPE.
- Checked firmware behavior too: HAL's existing socket queues already use nonblocking descriptors and suppress SIGPIPE on macOS; those files remain unchanged. The standalone firmware `trySendSocket` adapter now sets SO_NOSIGPIPE itself on systems without MSG_NOSIGNAL, instead of relying on the caller's signal disposition. Existing fd bounds and zero-time select remain in place.
- Validation: the 24-case suite passes on Linux GCC and Clang; watchdog self-tests pass. **`pnpm verify` passes** on Linux, including both compiler suites, watchdog checks, 460 Vitest tests and all 7 Playwright tests. Actual macOS / Apple clang verification must come from the next CI run. Status remains **in-review**; no push or rebase.

### Telemetry cadence after Serial capacity rebase

- Reproduced the reported failure on rebased head `e6081fc`: telemetry timestamps **4353 → 4408 ms** (55 ms interval) during the test's overlong-input burst at 4400 ms. Peak Serial output was only **127 bytes per tick**, well below the 16 KiB frame limit, and the expected Serial logs were present. The network telemetry path does not consult Serial capacity; no telemetry line was skipped by that API.
- Root cause: firmware scheduled telemetry relative to its last late loop timestamp (`lastTelemetryMs = now`) and checked it only after processing the entire input burst. At 4353 ms, the next relative deadline became 4403 ms; command processing held that poll until 4408 ms. The additional normal HAL call cost for `availableForWrite()` changed the loop phase enough to expose the existing scheduling flaw. HAL's implementation is correct for this use, and no HAL files were edited.
- Replaced that schedule with boot-anchored 50 ms deadlines (`next += periods * 50`), checked between bounded input slices after sensor/avoidance/output updates with a fresh uptime reading. Repeated late polls do not accumulate phase drift. Missed periods after a long stall are skipped without a catch-up burst; telemetry timestamps still report actual uptime. Kept the existing interval assertion and added an absolute phase check (at most 2 ms polling jitter), plus pure timer tests for late passes, missed periods and millis wrap.
- Validation: 27 firmware doctest cases pass with GCC and Clang. **`pnpm verify` passes**, including both firmware compiler runs, watchdog checks, 460 Vitest tests, both HAL suites (43 cases each) and all 7 Playwright tests. Status stays **in-review**; no push or rebase. The Serial capacity contract request is resolved; no new request is needed.

### Merged (orchestrator, 2026-11-18)

Review round 4 approved `490cafd`; CI green on Linux and macOS (macOS in 3.5 min, confirming the hang fix). The contract change request (`Serial.availableForWrite`) landed on main as `addc31c`. Non-blocking follow-ups, not fixed:

- `scripts/run-host-tests.mjs` spawns the test binary `detached`, so Ctrl-C of `pnpm test` orphans it and its firmware child until their bounded socket operations end. Forward SIGINT/SIGTERM to the group.
- The 60 s watchdog covers the whole binary, including the 5,100-tick integration run. A much slower runner would be reported as a hang; make it per-case or raise it to about 120 s if that happens.
- After a reconnect, the first telemetry line arrives on the next 50 ms grid slot (up to 50 ms after `hello`). Document it in the README.
- `tof_mm: 0` means both "failed sensor" and "no target", because control-protocol SPEC.md has no failure value. Tracked for P3.
- Desktop copy filter: exclude `scripts/`, `test/` and `package.json` when creating a project from the template. P1-D follow-up, tracked for P2-01.
