# P1-B — sim-core: sensor models

Status: todo
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

- [ ] `pnpm verify` passes
- [ ] a ToF sensor facing a wall 500 mm away reads 500 ± 3σ mm over 1 000 readings, at the configured rate (counted over 1 s of sim time)
- [ ] a wall beyond max range gives out-of-range readings
- [ ] an HC-SR04 echo high time for 1 m is 5 831 µs ± 1%
- [ ] an IMU at rest reads gravity on the up axis within bias + noise; spinning the vehicle in place shows the expected yaw rate
- [ ] adding a sensor leaves an existing sensor's reading sequence unchanged for the same seed

## Out of scope

Delivering readings to firmware (P1-H), the camera.

## Handoff

- **Built**:
- **Deviations from the brief**:
- **Contract change requests**:
- **Open questions**:
