# apps/desktop/src/shared (contract)

The typed API between the renderer and the main process. **`ipc.ts`** defines `RcsimApi`, one interface per service:

- `project`: open/create, `car.json`, files, watch;
- `catalog`: built-in and custom parts;
- `build`: sim or ESP32 builds, output, diagnostics;
- `pty`: shells;
- `run`: start/stop/pause/step/speed, snapshots, serial, status;
- `worldEdit`: obstacles and layouts;
- `control`: the control-protocol client, for driving and the Network Console.

The preload exposes exactly this object as `window.rcsim`, and main implements it. Everything here is renderer-safe: no Node, no Electron. ESLint enforces that, and allows only the Node-free package entry points `@rcsim/control-protocol/messages`, `@rcsim/sim-core/api` and `@rcsim/sim-core/stubs`.

## Wiring it (P1-D)

`IPC_METHODS` and `IPC_EVENTS` list every member of each service. The compiler rejects any name that isn't in the interface, and a test checks that the lists are complete.

- **Methods** use the channel `ipcChannel(service, method)`, i.e. `"<service>:<method>"`. The preload calls `ipcRenderer.invoke(channel, ...args)`, and main registers `ipcMain.handle(channel, (_e, ...args) => impl[service][method](...args))`.
- **Events** (`on…`) use the channel `"<service>:<event>"`. Main sends `webContents.send(channel, ...args)`, where `EventArgs<service, event>` gives the argument types. The preload's `on…(listener)` registers `ipcRenderer.on(channel, (_e, ...args) => listener(...args))` and returns the remover.
- **Errors.** `invoke` keeps only an error's message, so main throws `new Error(ipcErrorMessage(code, text))` and the renderer calls `parseIpcError(error)` to get `{code, message}` back. The codes (`no-project`, `wiring-errors`, `no-run`, `busy`, …) are listed in `IpcErrorCode`.
- **Stubs for now.** Until P2-01, `run`, `worldEdit` and `control` reject with `not-implemented`.
- **Data.** All arguments and results are structured-clone data: plain objects, arrays, strings and numbers. File paths are project-relative with `/` separators.

## Faking main (renderer tests, P1-E and P1-F)

**`fake-api.ts`**: `createFakeRcsimApi(options)` returns `{ api, calls, files, emit, setBuildDiagnostics }`. It behaves like main, in memory:

- **project:** files live in a `Map`. The default is the example car, its generated header, a stub `src/main.cpp` and `platformio.ini`. `writeCar` writes `car.json` and regenerates `include/car_config.h` byte-identically to `generateCarConfigHeader`.
- **catalog:** the built-in parts plus every valid `parts/*.json`. `saveCustomPart` validates with `PartDefinition` and fires `onChange`.
- **build:** reports the diagnostics set with `setBuildDiagnostics` (none means success), as one `output` event and one `done` event.
- **run / worldEdit:** `start` loads the world; `pause`, `resume`, `stop` and `setSpeed` fire `onStatus`. Obstacle edits change the live layout returned by `currentLayout()`. Use `emit.snapshot(snapshot)` to drive views. Real snapshots come from `@rcsim/sim-core/stubs` (`createFakeRun`).
- **control:** commands are recorded, and return false until `connect`. Use `emit.controlMessage(telemetry)` for incoming messages.
- **pty:** `write` echoes the data back as `onData`.

```ts
import { createFakeRcsimApi } from '../../shared/fake-api.ts';

const fake = createFakeRcsimApi();
render(<Workbench api={fake.api} />);
// …interact…
expect(fake.calls.at(-1)).toMatchObject({ service: 'project', method: 'writeCar' });
```

Pass `fake.api` to components, or set `window.rcsim` in a jsdom test. Inspect `fake.calls` to check what the view asked main to do.
