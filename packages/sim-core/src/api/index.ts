// The sim-core API contract (P0-05): interfaces between the parts of
// sim-core, used in parallel by P1-A (clock, world, vehicle, actuators, run,
// scenario), P1-B (sensors) and P1-H (firmware bridge). Fakes: ./stubs/.

export const PACKAGE_NAME = '@rcsim/sim-core';

export * from './math.ts';
export type { Rng, RngStreams, SimClock } from './clock.ts';
export type {
  CollisionEvent,
  CreateWorld,
  ObstacleState,
  RaycastHit,
  RaycastOptions,
  World,
  WorldStepEvents,
} from './world.ts';
export {
  WHEEL_ORDER,
  type Vehicle,
  type VehicleCommand,
  type VehicleSpec,
  type VehicleState,
  type WheelState,
} from './vehicle.ts';
export type { PartContext } from './parts.ts';
export type { ActuatorModel, ActuatorOutput, CreateActuatorModel, PwmSignal } from './actuators.ts';
export type {
  CreateSensorModel,
  SensorBeam,
  SensorContext,
  SensorModel,
  SensorReading,
} from './sensors.ts';
export {
  ActuatorSourceEnded,
  type ActuatorSource,
  type ActuatorSourceSetup,
  type CreateScriptedSource,
  type ScriptedPwm,
  type SourceEnd,
  type TickInput,
  type TickOutput,
} from './actuator-source.ts';
export type { StateSnapshot } from './snapshot.ts';
export type {
  CreateRun,
  Run,
  RunEnd,
  RunEvents,
  RunOptions,
  RunStatus,
  RunStepResult,
  Unsubscribe,
} from './run.ts';
export {
  parseAssertion,
  type ScenarioAssertion,
  type ScenarioMetric,
  type ScenarioResult,
  type ScenarioSpec,
} from './scenario.ts';
