// A host process for the SIGTERM test: starts a firmware that spins (so it
// never notices its socket closing), prints its pid, then waits to be killed.
// Usage: node host.ts <firmware binary> [install-handlers]
import { defaultCatalog, exampleCar } from '@rcsim/schema';
import { createFirmwareSource, installTerminationHandlers } from '../index.ts';

const [binary, mode] = process.argv.slice(2) as [string, string | undefined];
if (mode === 'install-handlers') installTerminationHandlers();
const source = createFirmwareSource({ binary, stallTimeoutMs: 60_000 });
await source.start({
  car: exampleCar,
  catalog: defaultCatalog,
  seed: 1,
  tickUs: 1000,
  devices: [],
});
// The first STEP starts the sketch, which then spins and never answers.
void source
  .step({
    tick: 0,
    t0Us: 0,
    t1Us: 1000,
    readings: [],
    gpioEdges: [],
    serialRx: new Uint8Array(0),
  })
  .catch(() => undefined);
await new Promise((resolve) => setTimeout(resolve, 300));
console.log(`pid ${source.pid} socket ${source.socketPath}`);
await new Promise(() => undefined);
