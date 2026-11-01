# P0-03 — Contract: schemas, wiring rules, default catalog

Status: done
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

- [x] `pnpm verify` passes
- [x] every PRD wiring rule has passing and failing fixtures
- [x] every catalog part validates and cites at least one datasheet
- [x] the example car passes with zero errors; a snapshot test pins its generated header

## Out of scope

UI, sim behaviour implementations (only their parameters live here).

## Handoff

- **Built**: `packages/schema`, documented in its README.
  - **Zod schemas** with inferred types, each sharing its schema's name. Every one has `schemaVersion: 1`, and objects are strict.
    - `PartDefinition`: a union on `category`. The controller variant adds a GPIO table; the chassis variant adds geometry and mount points.
    - `Behavior`: one union entry per template (7 templates).
    - `Car` (car.json), `World` and `Track`.
    - JSON Schemas are generated into `json-schema/`, and a test fails if they are stale.
  - **Wiring rules**: `checkWiring(car, catalog) → Issue[]` and `canRun()`. They resolve car.json into nets, so a wire may be declared from either end. 19 rule ids cover every PRD rule plus the structural rules needed to apply them. Each rule has passing and failing fixtures in `src/wiring/rules.test.ts`; a test checks that every rule id has a case.
  - **Header generator**: `generateCarConfigHeader()` gives byte-identical output whatever the JSON key order. It follows signal pins through a voltage divider (`SONAR_ECHO_PIN`). The example car's header is pinned in `examples/default-car.car_config.h`.
  - **Default catalog**: 11 parts in `catalog/`, every value cited in `sources`. Unpublished values are estimates, explained in each part's `notes`.
  - **Example car**: `examples/default-car.json` (`exampleCar`) has zero errors and zero warnings.
  - **Plain Node 26** imports the package directly (JSON import attributes), as the sim-core scenario CLI will.
- **Deviations from the brief**:
  - **Pin kind `analog-in` added** (a divider input), and **category `passive` added** for the voltage dividers, which are neither power nor sensor.
  - **Pin `voltage` can be `"supply"`**, for breakouts that shift I²C to VIN (the Pololu VL53L0X), or `{min,max}`, for a battery. Power-out pins carry a `maxCurrentMa` budget, and pins can be marked `optional`.
  - **Car pin targets can be another part's pin of any compatible kind**, not just a power pin. The HC-SR04 echo has to go through a divider.
  - **car.json gains `wifi`**, which the ADC2 rule needs.
  - **I²C addressing** is `fixed`, `strap` (AD0) or `software` with an `enablePin` (XSHUT).
  - **Chassis gains** `steeringLinkageRatio` (servo degrees to wheel degrees), `finalDriveRatio`, `driveWheels` and `trackWidthMm`.
  - **`electrical` is optional for power and passive parts**, because a battery has no supply input.
  - **Extra rules** beyond the PRD list: `reference`, `pin-kind-mismatch`, `rail-conflict`, `supply-voltage`, `no-adc`, `i2c-incomplete`, `i2c-address-invalid`, `i2c-address-unreachable`, `unconnected-pin`, `placement`.
  - **The Drive row** (ESC + 540 motor) is one part, `actuator.quicrun-1060-540`, with the `esc-motor` template.
  - **MPU6050 library**: `electroniccats/MPU6050@^1.4.5` (README has the reasons). hal shims its register API, not the DMP.
- **Review round 1.** Both reviews (Claude `code-review` and Codex adversarial) asked for changes. All blocking findings are fixed, each with new fixtures:
  - **Macro collisions** (both reviews): `tof__left` and `steering_` collided with `tof_left` and `steering`. Instance ids now forbid `__` and a trailing `_`, and a new `macro-clash` rule checks every emitted name.
  - **Missing types**: every exported schema now has its inferred type.
  - **I²C buses**: one SDA GPIO paired with different SCLs is now a `pin-conflict`.
  - **Boot-address isolation** (both reviews): it is required only when two or more devices answer at the boot address. The one unisolated part must move off that address.
  - **Over-voltage on inputs outside GPIO nets**, such as 6 V on AD0: the new input-tolerance check covers them, with an optional pin `maxInputV`. XSHUT gets 3.6 V, ST's absolute maximum.
  - **Divided digital signals** no longer trigger the ADC rules.
  - **Steering polarity** is now defined: `steeringLinkageRatio` is signed, positive meaning pulses above neutral steer right. The servo mapping is linear.

  Non-blocking findings fixed:
  - newlines in part names flattened in header comments;
  - strap addressing limited to exactly 2 addresses;
  - level-mismatch refs list only driving pins;
  - regulator and battery params must match their power-out pins;
  - `BEHAVIOR_TEMPLATES` and `PART_CATEGORIES` derived from the unions;
  - `findPin` and `hex` shared;
  - `prettier` and `vitest` declared as devDependencies;
  - the unreachable two-GPIO branch removed, with the reason in a comment;
  - Slash track width set to an estimated 240 mm between tyre centres.

- **Review round 2.** Both reviews confirmed the round 1 fixes and found more, all fixed with fixtures:
  - **Codex, blocking**: I²C is open-drain, so the controller's 3.3 V no longer counts on I²C lines (a 2.8 V-pulled bus passes). The Pololu SDA/SCL tolerate 5.5 V on the host side.
  - **Codex, blocking**: an enable pin (XSHUT) tied to ground is an error.
  - **Claude, blocking**: I²C lines wired only to other parts, never reaching a GPIO, are `i2c-incomplete`.
  - **Claude, blocking**: the battery current check tolerates floating-point products (3300 mAh × 1.1 C).
  - **Codex**: the car name is quoted in the header, so a trailing backslash can't continue the comment.
  - **Claude, rail conflicts**: a GPIO straight to ground, an output shorted to ground, and an output fighting a rail are now caught.
  - **Claude, strap and boot address**: a strap pin driven by another part's output counts as controlled. A fixed device at the boot address makes every software-addressed part there unreachable.
  - **Claude, determinism**: when a signal reaches two GPIOs through dividers, the lowest wins, whatever the wire order.
  - **Claude, cleanups**:
    - ADC2 advice lists the controller's real ADC1 pins;
    - one `isDivider` helper;
    - `lineVoltage` requires its `exclude` argument, as documented;
    - the same-part wire message explains why it is rejected.
- **Review round 3** (Codex, one blocking finding, fixed): a strap-addressed device whose strap pin is on a GPIO no longer counts as permanently at the boot address. The firmware parks it on its other address while the software-addressed parts come up; only fixed devices and static straps block them.
- **Contract change requests**: none (this is the contract).
- **Open questions**:
  - Several values are unpublished estimates, each flagged in its part's `notes`:
    - MG996R: the 500–2500 µs pulse range.
    - QuicRun: pulse range, deadband, and the motor's Kv and torque at 7.4 V.
    - Slash: steering angle, linkage ratio, centre of gravity, wheel radius and chassis-only mass.
    - LiPo: internal resistance.
    - DevKitC: 5 V pin range and mass.

    Measure the real car and update them.

  - The Traxxas product page says final drive 12.58; the manual's stock gearing gives 15.3. I used 15.3.
  - Track data (oval, technical) is P1-A's, in `sim-core/assets/`. Only the `Track` schema is here.
