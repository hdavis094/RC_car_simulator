# sim-core API (contract)

These are the interfaces between the parts of sim-core. P1-A (clock, world, vehicle, actuators, run, scenario CLI), P1-B (sensors) and P1-H (firmware bridge) build against them in parallel. The folder holds types and doc comments only. Fakes live in `stubs/`, imported as `@rcsim/sim-core/stubs`.

## The pieces

| File | Interface | Implemented by |
|---|---|---|
| `clock.ts` | `SimClock`; `Rng` and `RngStreams` (named, seeded streams) | P1-A (or adopt `stubs/rng.ts`) |
| `world.ts` | `World`: physics step, raycasts, obstacle editing, `toWorldFile()`; `CreateWorld` | P1-A |
| `vehicle.ts` | `Vehicle`, `VehicleCommand`, `VehicleState`, `WheelState` | P1-A |
| `actuators.ts` | `ActuatorModel` (PWM → `ActuatorOutput`); `CreateActuatorModel` | P1-A |
| `sensors.ts` | `SensorModel` (`update` → readings, plus GPIO hooks for the HC-SR04); `CreateSensorModel` | P1-B |
| `actuator-source.ts` | `ActuatorSource` (STEP in, STEP_DONE out); `ScriptedPwm`; `ActuatorSourceEnded` | P1-H (firmware); P1-A (scripted) |
| `run.ts` | `Run`, `RunOptions`, `RunEvents`, `CreateRun` | P1-A |
| `snapshot.ts` | `StateSnapshot`, what the renderer draws | P1-A (via `Run.snapshot()`) |
| `scenario.ts` | `ScenarioSpec`, `ScenarioResult`, `parseAssertion` | P1-A (CLI), P1-H (`--firmware`, `--control`) |
| `parts.ts` | `PartContext`, everything a model knows about its part | — |

## Conventions

- **Units.** SI everywhere: metres, seconds, radians, kilograms, m/s. Sim time is integer µs (`nowUs`, `tUs`). Physics steps take seconds (`dtS`). Part files keep their labelled units (mm, g, µs, degrees). Convert them when you build a model.
- **Frames.** World: right-handed, +Y up, −Z forward at yaw 0. The vehicle pose is the chassis-frame origin (on the ground, midway between the axles). Vectors and quaternions are plain tuples, so snapshots cross IPC.
- **Signs.**
  - `steerAngleRad` and yaw: positive turns left.
  - `motorDuty`: positive drives forward.
  - The servo model applies the chassis's signed `steeringLinkageRatio`: `steerAngleRad = −θservo × ratio × π/180`. With the default positive ratio, a pulse above neutral steers right.
- **Determinism.**
  - All time comes from `SimClock`, and all randomness from `RngStreams.stream(name)`.
  - A sensor uses `sensor:<instanceId>`, plus suffixes such as `sensor:imu:bias` for anything else. Never share a stream.
  - Iterate parts in `car.json` order.

## One tick

`Run` documents the order, and `stubs/fake-run.ts` implements it exactly. Use it as the reference loop:

1. `source.step(TickInput)`: STEP inputs go in (readings produced during the previous tick, GPIO edges from `takeGpioEdges`, serial RX, net faults), and STEP_DONE outputs come back.
2. PWM goes to `ActuatorModel.setPwm` by GPIO. GPIO writes go to the `SensorModel.onGpioWrite` of the part that owns the pin.
3. `ActuatorModel.update` produces the `VehicleCommand`, via `vehicle.applyCommand`.
4. `world.step(dtS, nowUs)` runs physics and returns collisions. The Run counts collisions and laps.
5. `SensorModel.update` runs for every sensor. Its readings go into the next tick's STEP, one tick late, as `sim-protocol/SPEC.md → When things happen` says.
6. `clock.advance()`.

A `Run` is unpaced. Pause, single-step and speed belong to the caller (the app's SimService).

## Faking a neighbour

| You are | You need | Use |
|---|---|---|
| P1-A, testing physics without firmware | something to drive the car | `new FakeActuatorSource(timeline)` (or your own scripted source) |
| P1-A, testing `Run` before P1-B lands | sensor models | the default `createFakeSensorModel` (constant readings at the update rate) |
| P1-B, testing sensors without physics | a world with something to hit, and a vehicle | `new FakeWorld(worldFile, track)`: obstacles are 0.15 m spheres for raycasts. `FakeVehicle` drives straight. |
| P1-B | a Rng | `createRngStreams(seed).stream('sensor:x')` |
| P1-H, testing the bridge before P1-A lands | a Run to plug the firmware into | `createFakeRun({ …, source: yourBridge })` |
| P1-F / P2-01, needing snapshots | a moving car | `createFakeRun` with a `FakeActuatorSource` holding full throttle, then `run.snapshot()` |
| anyone | the PartContext of each part | `partContexts({ car, catalog })`, which resolves GPIOs with `@rcsim/schema`'s `gpioAssignments` |
| anyone | sim-protocol device kinds | `deviceKindOf(partContext)`, following `sim-protocol/SPEC.md`'s device-kind table |

```ts
import { defaultCatalog, exampleCar } from '@rcsim/schema';
import { FakeActuatorSource, createFakeRun } from '@rcsim/sim-core/stubs';

const run = await createFakeRun({
  car: exampleCar, catalog: defaultCatalog, world, track, seed: 1,
  source: new FakeActuatorSource([{ tUs: 0, gpio: 26, pulseUs: 2000 }]),
});
await run.step(1000);
run.snapshot(); // the car has moved about 3 m along −Z
```

`createFakeRun` accepts real pieces in place of fakes: `worldImpl`, `createActuatorModel` and `createSensorModel`. Swap yours in one at a time.
