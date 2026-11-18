# @rcsim/firmware-template

The starter firmware copied into every new car project. It runs on the real ESP32 and against the desktop HAL, using the same newline-delimited JSON control protocol on TCP port 3333.

## Build and connect

- Sim: `packages/hal/bin/build-sim packages/firmware-template` from the repo root. `$CXX` selects the compiler; the executable is `.rcsim/build/firmware` inside the car project. The sim supplies `RCSIM_SOCKET` when launching it.
- Hardware: `pio run -e esp32dev` from this directory, then upload using PlatformIO. The pinned [pioarduino 54.03.21-2 release](https://github.com/pioarduino/platform-espressif32/releases/tag/54.03.21-2) supplies Arduino-ESP32 **3.2.1** / ESP-IDF 5.4.2. Library versions are exact pins matching the HAL shims; ArduinoJson is 7.4.2.
- Set `CAR_WIFI_SSID` and `CAR_WIFI_PASSWORD` with quoted string build definitions in `platformio.ini`, or edit their defaults at the top of `src/main.cpp`. Join the same Wi-Fi network as the car, then connect to the car's IP on port 3333. The defaults (`DonkeyCar` / `change-me`) are placeholders for your own network. The HAL connects immediately and reports the remapped host port in its LISTEN event.

Boot centres steering and holds the ESC at 1500 µs for **3000 ms**, matching the default ESC part. The server and telemetry remain available during this interval. Drive commands cannot bypass arming. Boot mode is manual; repeat drive commands more often than every 500 ms to keep moving. E-stop latches until a mode command. A new connection replaces the previous controller and resets sequence tracking without clearing e-stop or refreshing the failsafe timer.

`car.json` and `include/car_config.h` are byte-for-byte copies of schema's default car and generated header. Refresh them together when the default car changes. Keep `kCarName` in `src/main.cpp` in sync if renaming a copied project. The example's relative `$schema` reference points at schema's JSON schemas in its original package; configure your editor's schema mapping when editing a copied project.

## Auto mode

Send `{"t":"mode","mode":"auto"}` to enable avoidance. Tuning constants live at the top of `src/main.cpp`. The car cruises on a clear path, steers away from the nearer side, and slows as the centre reading approaches 250 mm. A blocked centre causes a 300 ms stop followed by 600 ms reversing with opposite steering; the cycle repeats until clear. A sensor initialization failure or read timeout holds neutral. Zero/no target is clear space, distinct from a timeout internally. Steering uses 1000–2000 µs, a conservative subset of the default servo's range.

The initial constants need P2-01 tuning against the real v1 scenario. This package does not claim a verified lap or collision-free behavior. Real QuicRun forward/brake/reverse mode can require a double-tap to engage reverse; that behavior is outside the Phase 1 ESC model.

## Host verification

`pnpm --filter @rcsim/firmware-template test` runs formatting, checks the copied car/header, builds with HAL `build-sim`, and runs doctest with each distinct available compiler among `$CXX` (default `c++`), GCC and Clang. It needs no simulator process or PlatformIO. The `typecheck` script runs the same checks so the root `pnpm verify` includes them without changing shared scripts. HAL provides the pinned formatter, ArduinoJson and doctest; there is no new dependency.

- `src/commands.*`: pure command parser and bounded incremental line framing.
- `src/control.*`: pure sequence, mode, e-stop, failsafe, arming output gate and pulse mapping.
- `src/avoidance.*`: pure avoidance decisions with explicit state and time inputs.
- `src/main.cpp`: Arduino I/O and scheduling.

Tests cover invalid messages, clamping, CRLF, overlong-line recovery, sequence wrap and reconnect, the exact 500 ms boundary and uptime wrap, e-stop, all avoidance branches and timeout safety. The integration test launches the **built executable** against HAL's fake sim for 5.1 s, including 3 s arming and at least 2 s afterward. It checks neutral PWM throughout arming, 20 Hz telemetry, sensor readings, hello on both connections, client replacement, manual drive, stale sequences, failsafe and e-stop through real loopback sockets. Host traffic is synchronized by the STEP/STEP_DONE exchange; it is not used as a deterministic scenario input.
