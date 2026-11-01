# P0-03 — Contract: schemas, wiring rules, default catalog

Status: todo
Agent: Claude (Opus)
Branch: ws/p0-03
Depends on: P0-02

## Goal

`packages/schema` defines every data file the system reads or writes, checks pin assignments with the wiring rules, generates the car config header, and ships the default parts catalog. Three parallel tasks (sim-core, Workbench, firmware) build against it, so it has to be complete and unambiguous before Phase 1 starts.

## Owned paths

`packages/schema/`

## Read first

`docs/PRD.md` (Default parts catalog, Workbench), `GLOSSARY.md`, `docs/ARCHITECTURE.md` (Sensors and actuators).

## Requirements

1. **Zod schemas**, each with a `schemaVersion`. Export inferred types and JSON Schema files so non-TS tools can validate.
   - **Part definition.** Fields:
     - `id` (namespaced: `sensor.vl53l0x`), `name`, `category` (controller | chassis | actuator | sensor | power)
     - `massG`, `dimensionsMm`, an optional glTF model path
     - electrical: supply range, logic level, typical and peak current
     - `pins[]`, each with a name and a kind: power-in, power-out, gnd, i2c-sda, i2c-scl, pwm-in, digital-in, digital-out, analog-out, plus a voltage
     - `behavior: {template, params}`
     - `sources[]`: datasheet URLs
   - **Controller definitions** add a GPIO table with each pin's capabilities: input-only, ADC1/ADC2 channel, strapping, flash, UART0, touch.
   - **Chassis definitions** add wheelbase, track width, max steering angle, wheel radius, mass and centre of gravity, and the **mount points**, each with a position and a default orientation.
   - **Behavior template params**, one discriminated union entry per template: `distance-raycast` (min/max range, beam angle, rays, noise σ as % of distance, update Hz), `imu`, `servo` (travel, slew deg/s, pulse range), `esc-motor` (neutral pulse, arming ms, deadband, kv, max torque, throttle curve), `battery`, `voltage-divider`, `regulator`.
   - **`car.json`**: controller, chassis, and `parts[]`. Each part has an instance id (C-identifier-safe), a part definition id, a placement (mount point + offset mm + yaw/pitch deg), a pin assignment (part pin → GPIO, or → another part's power pin), and a target I²C address.
   - **World**: track id, obstacles[] (type, position, yaw), start pose, seed.
   - **Track**: centreline as a closed polyline or spline, width, wall height, start/finish line. Laps are counted at the start/finish line.
2. **Wiring rules**: `checkWiring(car, catalog) → Issue[]`. Each issue has a severity (error | warning), a rule id, part and pin refs, and a human-readable message. Cover every rule in PRD → Workbench, with at least one passing and one failing test fixture per rule.
3. **Header generator**: `generateCarConfigHeader(car, catalog) → string`. It emits `#define`s named after the part instance ids (`TOF_LEFT_XSHUT_PIN 25`, `TOF_LEFT_I2C_ADDR 0x30`) with an include guard and a "generated — do not edit" banner. Output must be stable: the same input gives byte-identical output.
4. **Default catalog** in `packages/schema/catalog/`: every part in the PRD table, plus a 1 kΩ/2 kΩ level-shifting divider for the HC-SR04 echo pin. Check every value against a datasheet and cite it in `sources`.
5. **Example `car.json`**: the full default car (three VL53L0X at front-left/centre/right, MPU6050, servo, ESC, battery divider on an ADC1 pin). It must pass `checkWiring` with zero errors. P1-G and P2-01 reuse it.
6. **Choose the MPU6050 Arduino library** that hal will shim: popular, maintained, and compatible with the ESP32. Record the choice and the exact PlatformIO `lib_deps` ids for all shimmed libraries in `packages/schema/README.md`.

## Acceptance

- [ ] `pnpm verify` passes
- [ ] every PRD wiring rule has passing and failing fixtures
- [ ] every catalog part validates and cites at least one datasheet
- [ ] the example car passes with zero errors; a snapshot test pins its generated header

## Out of scope

UI, sim behaviour implementations (only their parameters live here).

## Handoff

- **Built**:
- **Deviations from the brief**:
- **Open questions**:
