// @rcsim/sim-core: the headless simulation. The API contract (types) is in
// ./api; the implementation below runs in Node, the sim host and the CLI.
// Renderer code imports `@rcsim/sim-core/api` or `/stubs` instead of this.
export * from './api/index.ts';
export { TickClock, createRngStreams } from './clock/index.ts';
export {
  createWorld,
  LapCounter,
  OBSTACLE_SIZES,
  PhysicsWorld,
  sampleCentreline,
  trackLibrary,
} from './world/index.ts';
export { RapierVehicle, vehicleParams, type VehicleParams } from './vehicle/index.ts';
export { createActuatorModel, createEscModel, createServoModel } from './actuators/index.ts';
export { createRun, type MeasuredRun, type RunMetrics } from './run/index.ts';
export {
  ScenarioInputError,
  createScriptedSource,
  parseTimeline,
  rcsimMain,
  runScenario,
  snapshotHash,
  type CliIo,
  type ScenarioIo,
} from './scenario/index.ts';
