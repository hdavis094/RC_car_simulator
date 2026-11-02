// Fakes of every sim-core interface, for tests and for tasks whose
// neighbours haven't merged yet. Import from '@rcsim/sim-core/stubs'.

export { createRngStreams } from './rng.ts';
export { FakeClock } from './fake-clock.ts';
export { FakeVehicle, FakeWorld } from './fake-world.ts';
export { createFakeActuatorModel, createFakeSensorModel } from './fake-models.ts';
export { FakeActuatorSource } from './fake-source.ts';
export { createFakeRun, deviceKindOf, partContexts } from './fake-run.ts';
