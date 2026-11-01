# Donkey Car Simulator — Product Requirements

Working name. Standalone: it shares the "Donkey Car" idea of a small autonomous RC car, not the `donkeycar` codebase (see [Later](#later)). Original idea: `outlilne.md`.

## Purpose

Design an RC car's electronics and test its firmware against a faithful simulation before flashing real hardware. The first user is the author building one real car; parts are data files, so the catalog grows without code changes.

## Platforms

Linux (x86_64) and macOS 14+ (Apple Silicon and Intel) are both first-class in v1. Every feature works on both, and CI runs `pnpm verify` on both.

- **v1 runs from source**: `pnpm install && pnpm dev`. Prerequisites:
  - Node 26 and pnpm
  - a C++ compiler: GCC or Clang on Linux; Xcode Command Line Tools on macOS (`xcode-select --install`)
  - PlatformIO, only for flashing a real board; the app offers to install it
- **Packaged apps** (AppImage, unsigned `.dmg`) come in Phase 3. A signed and notarized macOS app needs an Apple Developer account and is scheduled later.

## v1 acceptance demo

> In the **Workbench** I pick an ESP32, a steering servo, an ESC and motor, and distance sensors, assign their pins, and get no wiring errors. In the **Terminal** I write firmware and build it. I press **Run in Sim**, and in the **3D World** the car drives the oval and avoids cones I placed, while I watch its serial output and send it commands from the Network Console. I switch to manual and drive it with a gamepad.

The same demo runs headless as the **v1 scenario test** (see `docs/ARCHITECTURE.md` → Testing). v1 ships when that test and the manual demo both pass.

## The car

The ESP32 is the whole brain. It reads every sensor, decides, and drives the actuators. Firmware is Arduino-framework C++ in a PlatformIO project, and the identical source builds for the real board.

### Default parts catalog

Chosen so the car works in real life. Exact electrical values are verified against datasheets when the catalog is written (task P0-03).

| Role | Part | Interface |
|---|---|---|
| Controller | ESP32-DevKitC (WROOM-32) | — |
| Chassis | 1/10 Ackermann-steer, 2WD | mount points |
| Drive | 540 brushed motor + Hobbywing Quicrun 1060 ESC | 50 Hz PWM, 1000–2000 µs |
| Steering | MG996R servo | 50 Hz PWM, 1000–2000 µs |
| Distance (×3) | VL53L0X ToF breakout | I²C, XSHUT pin each |
| Distance (alt) | HC-SR04 ultrasonic | trig/echo GPIO, 5 V echo |
| Motion | MPU6050 (GY-521) | I²C |
| Battery | 2S LiPo 7.4 V + resistor divider | ADC1 pin |
| Logic power | 5 V buck regulator from the LiPo | — |

The ESC's built-in BEC powers the servo; the buck regulator powers the ESP32 and sensors.

## Environments

### Workbench

- Pick parts from the catalog: one controller, one chassis, any number of others.
- **Pin assignment table**: map each part pin to an ESP32 GPIO. **Wiring rules** run live and block Run on errors:
  - pin used twice
  - output on an input-only pin (GPIO 34–39)
  - flash pins (GPIO 6–11) and UART0 (GPIO 1, 3) used
  - strapping pins (GPIO 0, 2, 5, 12, 15) used (warning)
  - ADC2 pin used for analog while Wi-Fi is on (ADC2 is unavailable with Wi-Fi)
  - 5 V signal into a 3.3 V input without a level shifter or divider
  - I²C address clash
  - current draw over a rail's budget
- **Placement**: attach each sensor to a chassis **mount point** (front-left, front-centre, front-right, roof, rear), fine-tune offset and angle numerically, and preview beams in 3D.
- **New Part** form: metadata, electrical values, pins, and one **behavior template** with parameters. It writes a part file into the project's `parts/`.
- Saves `car.json` and regenerates `include/car_config.h` (pin numbers, I²C addresses) for the firmware.

### Terminal

- File tree and Monaco editor over the car project.
- **Build** (desktop compile against `hal`), **Run in Sim**, **Flash to ESP32** (PlatformIO; installed on demand if missing).
- Build output with clickable compiler errors.
- **Serial Monitor** for the running car, and a real shell opened in the project folder.

### 3D World

- Two built-in tracks: an oval, and a technical circuit with tight corners.
- Obstacle palette: cone, box, wall section, ramp. Click to place; drag and rotate to adjust. Layouts save to `worlds/*.json` for repeatable runs.
- Run controls: play, pause, single-step, speed (0.25×–8× and unpaced).
- **Manual and auto modes.** Keyboard and gamepad input is sent to the firmware as control-protocol commands over the car's simulated Wi-Fi, exactly as a laptop would send them to the real car.
- Dockable panel with the Serial Monitor, the shell, and the **Network Console** (raw control-protocol session with the car).

## Simulation

- **Lockstep**: the sim owns the clock and advances in 1 ms ticks. Firmware time (`millis()`, `delay()`) is sim time. Runs are deterministic for a given firmware, world and seed.
- **Physics, built in two stages**: stage 1 is arcade-believable (steering, speed, collisions); stage 2 adds tyre grip and slip, mass and centre of gravity from the chosen parts, and battery sag. Actuator realism (servo slew, ESC arming and deadband) and sensor realism (noise, range limits, update rates, beam width) are in from the start, because those are what break real firmware.
- **Wi-Fi** maps onto real local sockets, so any client (Network Console, a laptop script, a phone on the LAN) talks to the sim car as it would to the real one. Latency, loss and dropouts can be injected.

## Starter firmware

Every new project starts from it, and the v1 scenario test runs it:

- Serves the **control protocol** (newline-delimited JSON over TCP): `drive`, `mode`, `estop`, and a telemetry stream.
- **Auto mode**: obstacle avoidance with the three ToF sensors.
- **Failsafe**: in manual mode, stop if no command arrives for 500 ms.

## Car project on disk

A PlatformIO-compatible folder:

```
my-car/
  platformio.ini
  car.json              ← Workbench: parts, pins, placement
  include/car_config.h  ← generated by the Workbench
  src/main.cpp          ← firmware
  parts/*.json          ← custom parts
  worlds/*.json         ← saved obstacle layouts
```

## Out of v1

Camera sensor and image streaming · multiple cars · track editor · scripted part behaviors · visual wiring diagram · Windows.

## Later

- **Phase 3**: flash and real serial monitor via PlatformIO, network fault injection UI, physics stage 2, WebSocket transport for the control protocol, packaged Linux and macOS apps.
- **Beyond**: hardware-in-the-loop (real ESP32 on USB fed by the sim), `gym-donkeycar` protocol so `donkeycar` Python and trained models can drive, a Raspberry Pi brain alongside the ESP32, camera sensor.
