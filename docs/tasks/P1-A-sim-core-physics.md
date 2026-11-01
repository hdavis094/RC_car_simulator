# P1-A — sim-core: clock, world, vehicle physics, actuators

Status: todo
Agent: Claude (Sonnet sub-agent)
Branch: ws/p1-a
Depends on: P0 (all)
Wave: 1

## Goal

A headless, deterministic simulation in which a car built from `car.json` drives one of the two tracks, collides with obstacles, and responds to PWM through realistic servo and ESC models. Physics stage 1 (arcade-believable), with actuator realism included. Every other sim feature hangs off this.

## Owned paths

`packages/sim-core/src/{clock,world,vehicle,actuators,scenario}/`, `packages/sim-core/assets/`

## Read first

`packages/sim-core/src/api/` and its README, `packages/schema` (chassis, behavior params, world, track), ADR 0003, ARCHITECTURE.md → Testing.

## Requirements

1. **`SimClock`** and seeded `Rng` with named streams, per the API.
2. **World**:
   - Rapier deterministic WASM build (`@dimforge/rapier3d-deterministic-compat`)
   - the ground, plus track walls generated from track data
   - obstacles as colliders, with live add/move/remove
   - raycast query service for sensors
3. **Tracks** in `assets/tracks/`:
   - `oval`: about 12 × 6 m, 1.2 m lane
   - `technical`: hairpin, chicane, about 20 m lap
   - start/finish lines and lap counting
4. **Vehicle**: Rapier `DynamicRayCastVehicleController`, built from the chassis definition (wheelbase, track width, wheel radius, mass, CoG), with Ackermann steering and drive torque on the driven wheels. Expose collision events with obstacles and walls.
5. **Actuators**:
   - servo (pulse → target angle, slew-limited)
   - ESC (no output until neutral is held for the arming time, deadband, throttle curve; no reverse logic in stage 1)
6. **Scripted `ActuatorSource`**: a timeline of `{tUs, pin, pulseUs}`.
7. **`Run`**: assemble the clock, world, vehicle and actuators. Expose `step(n)` and `snapshot()`.
8. **Scenario CLI** `rcsim`:
   - `run --car <car.json> --world <world.json> --seconds N --seed S --script <timeline.json> --assert <expr>...`
   - assertions: `collisions == 0`, `laps >= 1`, `maxSpeed < x`
   - prints JSON results and exits non-zero on a failed assertion
   - the bridge (P1-H) adds `--firmware` later through the `ActuatorSource` interface

## Acceptance

- [ ] `pnpm verify` passes
- [ ] **determinism**: the same inputs and seed, run twice, give bit-identical snapshot hashes after 10 000 ticks
- [ ] **steering**: at full lock and walking pace, the turn radius is within ±10% of `wheelbase / tan(maxSteer)`
- [ ] **ESC arming**: a throttle pulse before neutral has been held for the arming time produces no motion
- [ ] **collisions**: a scripted straight run into a cone reports exactly one collision event
- [ ] **laps**: a scripted timeline that completes the oval counts one lap
- [ ] **speed**: `rcsim run` of 60 s at 1 ms ticks finishes in under 10 s of wall time

## Out of scope

Sensors (P1-B), the firmware bridge (P1-H), rendering, stage 2 physics (tyre slip, battery sag, ESC reverse double-tap).

## Handoff

- **Built**:
- **Deviations from the brief**:
- **Contract change requests**:
- **Open questions**:
