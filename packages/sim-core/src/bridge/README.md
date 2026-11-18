# Firmware bridge

Runs a firmware process (built by hal's `build-sim`) in lockstep with a `Run`, over [sim-protocol](../../../sim-protocol/SPEC.md). It implements `ActuatorSource` (`createFirmwareSource`); everything else about a tick (PWM into actuator models, GPIO writes to sensor models, readings and edges back) is the `Run`'s, as documented in `api/README.md`.

| File                  | What                                                                                                           |
| --------------------- | -------------------------------------------------------------------------------------------------------------- |
| `firmware-source.ts`  | `FirmwareSource`: the socket server, process, handshake, one STEP/STEP_DONE per tick, stall/crash/restart/stop |
| `channel.ts`          | one connection: frames in and out, queued events                                                               |
| `process.ts`          | one firmware process: stderr tail, exit status                                                                 |
| `control-script.ts`   | `--control` timelines, and `ControlledSource`, which plays them into a firmware's TCP server                   |
| `fixtures/*/main.cpp` | sketches the tests build with `build-sim`                                                                      |

## How it behaves

- `start` listens on `/tmp/rcsim-<pid>-<n>.sock`, spawns the binary with `RCSIM_SOCKET` (working directory: the project when the binary is `<project>/.rcsim/build/firmware`), reads `HELLO`, answers `CONFIG` (the `Run`'s device table; `halCallCostNs` 1000, `loopCostNs` 5000). A firmware speaking another protocol version gets `BYE(version-mismatch)`.
- `step` sends one `STEP`: readings get their device index and are ordered by device, then time; at most 16 KiB of Serial RX goes in one `STEP` and the rest follows in later ticks (hal's own RX queue holds 16 KiB and drops the excess, as a UART buffer would). It then waits for the `STEP_DONE` of that tick.
- **No answer in `stallTimeoutMs` of wall time** (default 2000; also covers connecting): `BYE(stalled)`, SIGKILL, `ActuatorSourceEnded({kind:'stalled'})`. This is the only wall-clock read in sim-core (ADR 0003).
- **Messages are checked as they arrive**, against the protocol's state then: `HELLO` only first, `STEP_DONE` only while a `STEP` with that tick is outstanding and unanswered, `BYE` any time. Anything else (a `STEP_DONE` before `CONFIG`, a duplicate, a wrong tick, an invalid frame) gets `BYE(malformed)` and the run ends `{kind:'error'}`, as SPEC.md says.
- **The process dies or the connection drops**: `{kind:'crashed', exitCode, signal, stderrTail}`; a firmware `BYE` message is appended to the tail. A message too big to send is `{kind:'error'}` too.
- `restart` (the app's "reboot") ends the process politely, spawns a new one on the same socket, and handshakes again; the next `STEP` carries the run's current tick, so `setup()` runs at that tick and the firmware's own `millis()` starts at 0. Network faults set before the reboot are sent again, and every PWM pin the old firmware was driving is reported stopped (`periodUs` 0) with the next tick, as a board reset releases its pins: an armed ESC loses its signal and disarms, and a servo holds. Whatever the new firmware sets up in that same tick follows and wins.
- `stop` is safe at any time, during a step too: the step ends with `finished`. During `start` it waits for `start` to notice (it checks after every wait) and then removes whatever was made: no socket file and no process remain. It kills a process that lingers.
- Waits are one per tick and nothing long-lived is raced: the process-exit and stop reactions are attached once per process, so a run of any length holds a constant number of them.

## When the host goes away

A sketch that never calls hal doesn't notice its socket closing, so a host that dies leaves it spinning. Three layers:

- **Always:** an `exit` hook kills live firmware when the host returns or calls `process.exit()`. It changes no exit behaviour, so the library has it.
- **The desktop app:** call `killAllFirmware()` (exported from this folder) in the main process's quit handling (`before-quit`/`will-quit`, and its own signal handling). It also removes the sockets, is synchronous, and is safe in a signal handler.
- **The `rcsim` CLI:** `scenario/bin.ts` calls `installTerminationHandlers()`, which kills the firmware on SIGTERM, SIGINT or SIGHUP and then lets the signal take its default course. A library must not install signal handlers (they change its host's exit behaviour), so nothing else calls it.

Nothing can survive SIGKILL of the host: a spinning firmware would be orphaned. hal exits when its socket reaches EOF, which covers every firmware that calls hal.

## Control timelines

`rcsim run --firmware <binary> --control <timeline.json>` wraps the firmware source in a `ControlledSource`. Each entry is written to the firmware's TCP server at the **first tick boundary at or after its `tUs`, never before**: delivery is quantised to tick starts, so an entry is up to one tick late (with 1 ms ticks, 100 900 µs goes out at 101 000 µs; 101 000 µs goes out at 101 000 µs). The server is found through the firmware's `LISTEN` net event, so the host port hal chose doesn't matter. Entries wait for the port to start listening.

```json
[
  { "tUs": 500000, "message": { "t": "mode", "mode": "manual" } },
  {
    "tUs": 1000000,
    "message": { "t": "drive", "seq": 1, "throttle": 0.3, "steer": 0 },
    "everyMs": 100,
    "untilUs": 5000000
  },
  { "tUs": 6000000, "port": 3333, "line": "not json, sent verbatim" }
]
```

`message` is checked against the control-protocol client schema; `line` is sent as is. `everyMs` with `untilUs` repeats an entry (a repeated `drive` has its `seq` raised each time, wrapping at 2³²), the way a client resends a held stick against the 500 ms failsafe. The car's replies are read and kept in `ControlledSource.received`.

**Writes never block a tick.** A line is queued on the socket and not waited for, because the firmware reads its sockets only while a tick runs; waiting for it to drain would deadlock. Only the first connection to a port is awaited (the kernel completes it without the firmware), under the stall timeout. Lines too many for the socket buffers reach the firmware over the following ticks.

**Unsent entries fail the scenario.** A scenario that ends with entries never delivered (a time after the run's end, or a port the firmware never listened on) fails: `passed` is false, `end` is `{kind:'error', message}` naming the entries and their ports, and the CLI exits 1. (`ScenarioResult` has no dedicated field; see the P1-H handoff.)

Live TCP is the one input hal can't make deterministic (the hal README says so). A script over loopback is as close as it gets: every write is flushed to the firmware's socket before the `STEP` that follows it.
