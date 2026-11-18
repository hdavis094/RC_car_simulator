# P1-B — sim-core: sensor models

Status: in-review
Agent: OpenCode (freebeam)
Branch: ws/p1-b
Depends on: P1-A
Wave: 2

## Goal

Every sensor behavior template produces realistic, seeded readings at its own update rate. These are what the firmware reacts to; noise, range limits and beam width are what break real code, so they matter more than visual accuracy.

## Owned paths

`packages/sim-core/src/sensors/`

## Read first

`packages/sim-core/src/api/` (`SensorModel`, `Rng`, `World` raycasts), `packages/schema` (behavior params), ARCHITECTURE.md → Sensors and actuators.

## Requirements

1. **`distance-raycast`**:
   - casts the configured number of rays across the beam angle from the part's placement; the nearest hit wins
   - out of range gives an out-of-range reading, not a clamped value
   - Gaussian noise σ as a % of distance, quantised to 1 mm
   - readings at the update rate
   - the VL53L0X and HC-SR04 catalog entries differ only in parameters
2. **HC-SR04 timing**: on a trigger pulse ≥ 10 µs, schedule an echo edge pair with a high time of `2·d / 343 m/s`, the real start delay, and timeout behaviour when nothing is in range. Use the µs-stamped GPIO edge path.
3. **`imu`**: accelerometer (including gravity) and gyro in the body frame from vehicle state, plus noise and a constant per-run bias drawn from the seed, at the configured rate and full-scale range.
4. **`battery` + `voltage-divider`**: pack voltage (stage 1 constant; a hook for stage-2 sag) through the divider into a 12-bit ADC reading, using the ESP32's ADC attenuation curve.
5. Each model draws only from its own named `Rng` stream.

## Acceptance

- [x] `pnpm verify` passes
- [x] a ToF sensor facing a wall 500 mm away reads 500 ± 3σ mm over 1 000 readings, at the configured rate (counted over 1 s of sim time)
- [x] a wall beyond max range gives out-of-range readings
- [x] an HC-SR04 echo high time for 1 m is 5 831 µs ± 1%
- [x] an IMU at rest reads gravity on the up axis within bias + noise; spinning the vehicle in place shows the expected yaw rate
- [x] adding a sensor leaves an existing sensor's reading sequence unchanged for the same seed

## Out of scope

Delivering readings to firmware (P1-H), the camera.

## Handoff

- **Built**: Implemented `packages/sim-core/src/sensors/` with `createSensorModel` dispatching to `distance-raycast`, `imu`, and `voltage-divider` models. Distance model casts the configured ray fan, applies range limits (out-of-range -> `no-target`, mm 8190), Gaussian noise (% of distance) quantised to 1 mm, and update-rate scheduling. HC-SR04 variant returns no readings and schedules µs-stamped ECHO edge pairs on a ≥10 µs TRIG pulse, with width `2·d/343` and timeout when out of range. IMU transforms vehicle state into the body frame including gravity, with per-run bias from `sensor:<id>:bias` and density-scaled noise, clamped to full-scale. Voltage-divider resolves the car's battery pack voltage (constant nominal, stage-1) through the divider. Each model uses only its own named Rng streams. Beams are produced for distance sensors. Updated `default-models.ts` and exported `createSensorModel`.
- **Deviations from the brief**: Updated `DRIVEN_GOLDEN_HASH` in `run.test.ts` to the new snapshot hash. Verified that the chassis trajectory (car pose/velocity) is bit-identical between the real and fake sensor models; the only snapshot field that changed is `sensors[].beams` (now non-empty for distance sensors; previously `[]`). No other snapshot field changed. Edited outside owned paths for this test constant to keep `pnpm verify` green.
- **Contract change requests**: None.
- **Open questions**: HC-SR04 start delay assumed 200 µs (8 cycles at 40 kHz); battery pack voltage uses cell nominal (stage 1).
- **Review round 1**: Addressed all blocking items: IMU chip-axis mapping (gravity on chip Z, yaw on chip gyro Z) including rotated placement; HC-SR04 echo anchored on TRIG falling edge with tick-straddle and stale-edge purge, plus ~38 ms timeout pulse; detection by TRIG/ECHO pins; rejection of sub-10 µs TRIG; exact update-rate accumulator (30 Hz -> 30 readings/s); ToF test strengthened (count, ±3σ, sample std); out-of-range wall just past max range with mm 8190; seed-independence also checks extra sensor produced readings; voltage divider uses `dividerRatio()`, per-reading `packVoltage()`, throws on missing battery, rate from part if defined; IMU bias constants named/commented, gravity constant, noise bandwidth comment; shared `test-helpers.ts` without `as never`. Full `pnpm verify` passes.
