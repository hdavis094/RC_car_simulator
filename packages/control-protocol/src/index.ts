// @rcsim/control-protocol: the JSON-lines protocol between a laptop and the
// car (SPEC.md), its TS client, and a fake car for tests.

export * from './messages.ts';
export { LineSplitter } from './lines.ts';
export {
  ControlClient,
  DEFAULT_RECONNECT,
  type ConnectionState,
  type ControlClientEvents,
  type ControlClientOptions,
  type ReconnectOptions,
} from './client.ts';
export { FakeCar, type FakeCarEvents, type FakeCarOptions, type FakeCarState } from './fake-car.ts';
