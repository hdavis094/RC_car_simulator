# @rcsim/firmware-template

The starter firmware copied into every new car project. It runs on the real ESP32 and against the desktop HAL, using the same newline-delimited JSON control protocol on TCP port 3333.

## Build and connect

- Sim: `packages/hal/bin/build-sim packages/firmware-template` from the repo root. `$CXX` selects the compiler; the executable is `.rcsim/build/firmware` inside the car project. The sim supplies `RCSIM_SOCKET` when launching it.
- Hardware: `pio run -e esp32dev` from this directory, then upload using PlatformIO. The pinned [pioarduino 54.03.21-2 release](https://github.com/pioarduino/platform-espressif32/releases/tag/54.03.21-2) supplies Arduino-ESP32 **3.2.1** / ESP-IDF 5.4.2. Library versions are exact pins matching the HAL shims; ArduinoJson is 7.4.2.
- Set `CAR_WIFI_SSID` and `CAR_WIFI_PASSWORD` with quoted string build definitions in `platformio.ini`, or edit their defaults at the top of `src/main.cpp`. Join the same Wi-Fi network as the car, then connect to the car's IP on port 3333. The defaults (`DonkeyCar` / `change-me`) are placeholders for your own network. The HAL connects immediately and reports the remapped host port in its LISTEN event.

Boot centres steering and holds the ESC at 1500 µs for **3000 ms**, matching the default ESC part. The server and telemetry remain available during this interval. Drive commands cannot bypass arming. Boot mode is manual; repeat drive commands more often than every 500 ms to keep moving. E-stop latches until a mode command. E-stop and every mode command discard the stored manual command; send a fresh drive to move again. Failsafe and arming remain latched across uptime wrap. A new connection replaces the previous controller and resets sequence tracking without clearing e-stop or refreshing the failsafe timer.

`car.json` and `include/car_config.h` are byte-for-byte copies of schema's default car and generated header. Refresh them together when the default car changes. Keep `kCarName` in `src/main.cpp` in sync if renaming a copied project. The example's relative `$schema` reference points at schema's JSON schemas in its original package; configure your editor's schema mapping when editing a copied project.

## Auto mode

Send `{"t":"mode","mode":"auto"}` to enable avoidance. Tuning constants live at the top of `src/main.cpp`. The car cruises on a clear path, steers away from the nearer side, and slows as the centre reading approaches 250 mm. A blocked centre causes a 300 ms stop followed by 600 ms reversing with opposite steering; the cycle repeats until the centre exceeds 325 mm, giving 75 mm of hysteresis. A sensor initialization failure or read timeout holds neutral. Zero/no target is clear space, distinct from a timeout internally. Steering uses 1000–2000 µs, a conservative subset of the default servo's range.

The initial constants need P2-01 tuning against the real v1 scenario. This package does not claim a verified lap or collision-free behavior. Real QuicRun forward/brake/reverse mode can require a double-tap to engage reverse; that behavior is outside the Phase 1 ESC model.

## Outbound safety

Every send first updates PWM with the current failsafe/e-stop state. JSON is serialized once into a bounded 512-byte line buffer, including LF. On Arduino-ESP32 3.2.1, `NetworkClient` inherits `Print::availableForWrite()` (always 0); its `write()` has fixed one-second select waits and ten retries. Socket send timeouts do not remove those waits. Firmware instead uses `client.fd()`, zero-time `select`, and one `send(MSG_DONTWAIT)` call. A compile-time check limits the whole line to lwIP's writable low-water mark; with a single writer, readiness guarantees enough send-buffer space for that line. Backpressure drops the line without waiting or retrying. Source links and the pinned lwIP reasoning are in `src/outbound.cpp`.

HAL builds use a local fallback to its existing nonblocking `WiFiClient::write` queue, preserving sim latency/loss injection. No `availableForWrite` shim is assumed. A defensive short-write result disconnects instead of appending another JSON line to an incomplete prefix. This fallback and the board adapter compile against their respective existing APIs; no HAL edit is required. The regression suite fills a host socket and verifies that dropped sends leave no prefix, still update outputs first, and enforce failsafe/e-stop without waiting. Battery telemetry uses `analogReadMilliVolts()` on both targets.

## Host verification

`pnpm --filter @rcsim/firmware-template test` runs formatting, checks the copied car/header, builds with HAL `build-sim`, and runs doctest with each distinct available compiler among `$CXX` (default `c++`), GCC and Clang. It needs no simulator process or PlatformIO. The `typecheck` script runs the same checks so the root `pnpm verify` includes them without changing shared scripts. HAL provides the pinned formatter, ArduinoJson and doctest; there is no new dependency. `scripts/`, `test/` and `package.json` are development-only and are expected to be excluded when the desktop copies this package into a new car project (P1-D copy-filter follow-up).

- `src/commands.*`: pure command parser and bounded incremental line framing.
- `src/control.*`: pure sequence, mode, e-stop, failsafe, arming output gate and pulse mapping.
- `src/avoidance.*`: pure avoidance decisions with explicit state and time inputs.
- `src/outbound.*`: bounded serialization and the board nonblocking socket adapter.
- `src/main.cpp`: Arduino I/O and scheduling, including periodic Wi-Fi connection status on Serial.

Tests cover invalid messages, clamping, CRLF, overlong-line recovery, sequence wrap and reconnect, the exact 500 ms boundary and uptime wrap, e-stop, all avoidance branches and timeout safety. The integration test launches the **built executable** against HAL's fake sim for 5.1 s, including 3 s arming and at least 2 s afterward. It checks neutral PWM throughout arming, 20 Hz telemetry, sensor readings, hello on both connections, client replacement, manual drive, stale sequences, failsafe and e-stop through real loopback sockets. Host traffic is synchronized by the STEP/STEP_DONE exchange; it is not used as a deterministic scenario input.
