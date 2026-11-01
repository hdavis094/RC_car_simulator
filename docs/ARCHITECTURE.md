# Architecture

How the modules fit together. The exact contracts (schemas, binary layouts, message fields) are fixed by Phase 0 and live in the contract packages. This document gives their shape and the rules that hold them together.

## Modules

pnpm workspace, one repo.

| Path | Language | What it is | Depends on |
|---|---|---|---|
| `packages/schema` | TS | Zod schemas for part definitions, `car.json` and worlds; wiring rules; `car_config.h` generator; default parts catalog (JSON) | — |
| `packages/sim-protocol` | spec + TS + vectors | Binary frame format between `sim-core` and a firmware process. Golden test vectors shared by both sides | — |
| `packages/control-protocol` | spec + TS | JSON-lines car control protocol (laptop ↔ car). TS client used by the app | — |
| `packages/sim-core` | TS, headless | Sim clock, world and tracks, vehicle physics (Rapier), actuator and sensor models, firmware bridge, scenario runner CLI | schema, sim-protocol |
| `packages/hal` | C++17 | Arduino/ESP32 API for desktop builds, library shims, sim-protocol client, Wi-Fi over host sockets, sim build driver | sim-protocol (spec + vectors) |
| `packages/firmware-template` | C++ | Starter firmware and `platformio.ini`; copied into every new car project | hal (sim), control-protocol (spec) |
| `apps/desktop` | TS, Electron + React | The app: main process services and the three environments | all of the above |

`sim-core` and `hal` never import UI code. `sim-core` runs the same in Electron, in plain Node tests and in the scenario CLI.

## Processes at run time

```
┌──────────── Electron app ─────────────────────────────────────────────┐
│ renderer (React)                    main process                      │
│  Workbench ─┐                        ProjectService  (files, car.json) │
│  Terminal  ─┼── typed IPC ─────────► BuildService    (c++ / pio)       │
│  3D World  ─┘   (src/shared/ipc.ts)  PtyService      (shells)          │
│     ▲  60 Hz StateSnapshot           SimService ──┐                    │
│     └──────────────────────────────────────────── │ ───────┐           │
│                                       ControlClient│ (TCP)  │           │
└────────────────────────────────────────────────── │ ────── │ ──────────┘
                                                    │        │
                     ┌──────────────────────────────▼──┐     │ control protocol
                     │ sim host (utilityProcess)        │     │ JSON lines / TCP
                     │  sim-core: clock, world, physics,│     │
                     │  actuators, sensors, bridge      │     │
                     └──────────────┬───────────────────┘     │
                        sim-protocol│ Unix socket, 1 frame/tick│
                     ┌──────────────▼───────────────────┐     │
                     │ firmware process (native binary) │◄────┘
                     │  user sketch + hal               │  real host socket
                     └──────────────────────────────────┘
```

- **The renderer displays and never owns sim state.** It receives `StateSnapshot`s (car pose, wheel states, sensor beams, obstacles) at about 60 Hz and sends user intents (place obstacle, pause, step) back through IPC.
- **The sim host** is an Electron `utilityProcess` running `sim-core`. Headless runs use the same code in plain Node.
- **The firmware process** is the user's sketch compiled natively against `hal`. One process per Run. If it crashes, the session reports it with stderr; restarting it is equivalent to the ESP32 rebooting.

## Lockstep time

`sim-core` owns time. A **tick** is 1 ms of sim time (configurable). Each tick:

```
sim-core                                   firmware (hal)
   │  STEP{tick, t0, t1, sensor readings,      │
   │       gpio edges (µs-stamped), serial rx} │
   │──────────────────────────────────────────►│ run user code until virtual
   │                                           │ clock ≥ t1
   │  STEP_DONE{tick, pwm outputs, gpio writes │
   │       (µs-stamped), serial tx, net events}│
   │◄──────────────────────────────────────────│
   │ apply actuators → physics step → sensors  │
```

- **Virtual time inside the firmware.** `delay()` and `delayMicroseconds()` advance it exactly. Every other hal call costs a small fixed amount (for example 1 µs per call and 5 µs per `loop()` return; the values are tunable), so busy-wait loops still progress. When virtual time crosses `t1`, hal sends `STEP_DONE` and blocks for the next `STEP`.
- **Stall detection.** If `STEP_DONE` doesn't arrive within 2 s of wall time, the session reports the firmware as stalled (on hardware the task watchdog would fire).
- **Pacing.** `sim-core` runs ticks as fast as it can. The app paces to wall clock at the chosen speed. Headless runs are unpaced.
- **µs-precise signals across 1 ms ticks.** GPIO edges carry µs timestamps. For an HC-SR04, firmware writes a trigger pulse; the sim schedules the echo edges for the following ticks; `pulseIn()` measures them from the timestamps.

## Sensors and actuators: who models what

- **sim-core computes physical measurements**: distance in mm along a beam, acceleration and angular rate, battery volts. It applies range limits, beam width (several rays, nearest hit), noise from the seeded `Rng`, and each part's update rate. It delivers a reading only when the part would produce one.
- **hal presents them through the library APIs firmware uses.** v1 uses **library-level shims** ([ADR 0002](adr/0002-library-shims-over-register-emulation.md)): sim builds replace the supported Arduino libraries with hal implementations that have the same headers and API and are fed by readings from `STEP`. The supported set is pinned in `firmware-template/platformio.ini`, for example `pololu/VL53L0X`, `ESP32Servo` and an MPU6050 library chosen in P0-03. Shims model the part's behaviour the firmware must handle: the VL53L0X boots at address 0x29 and answers only while XSHUT is high, so firmware has to bring sensors up one at a time and call `setAddress()`.
- **Actuators**: hal reports PWM pulse widths per pin. sim-core maps pins to parts through `car.json` and models the part: servo travel and slew rate; ESC neutral arming, deadband and throttle curve (stage 2 adds the brake/reverse double-tap).

## Wi-Fi

`WiFi.begin()` connects immediately. `WiFiServer`, `WiFiClient` and `WiFiUDP` are real non-blocking POSIX sockets inside hal, polled at hal call boundaries and serviced at tick granularity. The firmware's listen port is remapped to a free host port (the firmware's port 80 might become 127.0.0.1:41080), and hal reports the mapping as a net event so the app knows where to connect. The bind address defaults to `127.0.0.1`, with an option for the LAN. Fault injection (latency, loss, dropout) is applied inside hal from settings sent in `STEP`. Live network traffic is the one non-deterministic input. Scenario tests drive the car with scripted control-protocol input delivered at fixed ticks.

## Control protocol

Newline-delimited JSON over TCP, served by the firmware. It's the same on the real car and in the sim. The shape below is what P0-04 starts from:

```
→ {"t":"drive","seq":12,"throttle":0.4,"steer":-0.2}     # both in −1..1
→ {"t":"mode","mode":"manual"|"auto"}
→ {"t":"estop"}
← {"t":"telemetry","ms":1234,"mode":"auto","throttle":0.3,"steer":0.1,
   "tof_mm":[812,1200,640],"batt_mv":7810,"yaw_dps":12.5}  # ~20 Hz
← {"t":"log","msg":"..."}
```

The app's `ControlClient` (main process, using `control-protocol`) carries keyboard and gamepad input and the Network Console. It works unchanged against the real car's IP ([ADR 0004](adr/0004-manual-drive-over-control-protocol.md)).

## Builds

- **Sim build**: hal's build driver (`packages/hal/bin/build-sim`) compiles `src/*.cpp` with the system C++ compiler (`$CXX`, else `c++`), with hal's `include/` ahead of the real libraries. It links against a cached prebuilt hal library and writes `.rcsim/build/firmware`. Compiler output is passed through unchanged so the Terminal can link the errors.
- **Real build**: `pio run -e esp32dev` (and `-t upload`), driven by BuildService. If PlatformIO is missing, the app offers to install it.

## Testing

`pnpm verify` is the single bar: lint, typecheck, Vitest, hal's doctest suite (make, once with each available compiler of `g++` and `clang++`), the scenario tests, and Playwright against the Electron app. `pnpm verify:fast` skips Playwright and scenarios for the inner loop.

**Platforms.** CI runs `pnpm verify` on `ubuntu-latest` and `macos-latest`. Locally on Linux, building hal with both GCC and Clang catches most problems Apple clang would hit. Only the macOS CI job proves macOS works.

- **schema / sim-core**: Vitest. Physics gets property checks against geometry, e.g. the full-lock turn radius is within ±10% of the Ackermann prediction from the chassis wheelbase and steering angle.
- **hal**: doctest unit tests, plus protocol tests that replay the golden vectors in `sim-protocol/vectors/`. Both sides decode and encode the same bytes.
- **Scenario tests**: `sim-core`'s CLI runs a car project headless, e.g. `rcsim run --project <dir> --world <file> --seconds 60 --seed 1`, and evaluates assertions such as no collisions, laps ≥ 1, max speed. The **v1 scenario test** builds the starter firmware and runs 60 s on the oval with a fixed cone layout, asserting no collisions and at least one lap.
- **app**: Playwright `_electron` tests through all three environments.

## Ownership map

What each task may write. Contracts (bold) are written in Phase 0 and locked afterwards.

| Path | Owner |
|---|---|
| **`packages/schema/`** | P0-03 |
| **`packages/sim-protocol/`**, **`packages/control-protocol/`** | P0-04 |
| **`packages/sim-core/src/api/`**, **`apps/desktop/src/shared/`** | P0-05 |
| repo root config, CI, package scaffolds | P0-02 |
| `packages/sim-core/src/{clock,world,vehicle,actuators,scenario}/`, `packages/sim-core/assets/` | P1-A |
| `packages/sim-core/src/sensors/` | P1-B |
| `packages/hal/` | P1-C |
| `apps/desktop/src/main/`, `apps/desktop/src/preload/`, `apps/desktop/src/renderer/{shell,terminal}/` | P1-D |
| `apps/desktop/src/renderer/workbench/` | P1-E |
| `apps/desktop/src/renderer/world/` | P1-F |
| `packages/firmware-template/` | P1-G |
| `packages/sim-core/src/bridge/` | P1-H |
| wiring across all of the above, `e2e/` | P2-01 |
