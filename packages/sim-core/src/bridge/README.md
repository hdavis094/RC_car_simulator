# Firmware bridge

Runs a firmware process (built by hal's `build-sim`) in lockstep with a `Run`, over [sim-protocol](../../../sim-protocol/SPEC.md). It implements `ActuatorSource` (`createFirmwareSource`); everything else about a tick (PWM into actuator models, GPIO writes to sensor models, readings and edges back) is the `Run`'s, as documented in `api/README.md`.

| File | What |
|---|---|
| `firmware-source.ts` | `FirmwareSource`: the socket server, process, handshake, one STEP/STEP_DONE per tick, stall/crash/restart/stop |
| `channel.ts` | one connection: frames in and out, queued events |
| `process.ts` | one firmware process: stderr tail, exit status |
| `control-script.ts` | `--control` timelines, and `ControlledSource`, which plays them into a firmware's TCP server |
| `fixtures/*/main.cpp` | sketches the tests build with `build-sim` |

## How it behaves

- `start` listens on `/tmp/rcsim-<pid>-<n>.sock`, spawns the binary with `RCSIM_SOCKET` (working directory: the project when the binary is `<project>/.rcsim/build/firmware`), reads `HELLO`, answers `CONFIG` (the `Run`'s device table; `halCallCostNs` 1000, `loopCostNs` 5000). A firmware speaking another protocol version gets `BYE(version-mismatch)`.
- `step` sends one `STEP`: readings get their device index and are ordered by device, then time; at most 16 KiB of Serial RX goes in one `STEP` and the rest follows in later ticks (hal's own RX queue holds 16 KiB and drops the excess, as a UART buffer would). It then waits for the `STEP_DONE` of that tick.
- **No answer in `stallTimeoutMs` of wall time** (default 2000; also covers connecting): `BYE(stalled)`, SIGKILL, `ActuatorSourceEnded({kind:'stalled'})`. This is the only wall-clock read in sim-core (ADR 0003).
- **The process dies or the connection drops**: `{kind:'crashed', exitCode, signal, stderrTail}`; a firmware `BYE` message is appended to the tail. A malformed or unexpected frame, a wrong tick in `STEP_DONE`, or a message too big to send is `{kind:'error'}`.
- `restart` (the app's "reboot") ends the process politely, spawns a new one on the same socket, and handshakes again; the next `STEP` carries the run's current tick, so `setup()` runs at that tick and the firmware's own `millis()` starts at 0. Network faults set before the reboot are sent again.
- `stop` is safe at any time, during a step too: the step ends with `finished`. It removes the socket and kills a process that lingers. A process exit hook kills firmware that is still running if the host dies, because a sketch that never calls hal would not notice its socket closing.

## Control timelines

`rcsim run --firmware <binary> --control <timeline.json>` wraps the firmware source in a `ControlledSource`. Each entry is written to the firmware's TCP server just before the tick containing its time. The server is found through the firmware's `LISTEN` net event, so the host port hal chose doesn't matter. Entries wait for the port to start listening.

```json
[
  { "tUs": 500000, "message": { "t": "mode", "mode": "manual" } },
  { "tUs": 1000000, "message": { "t": "drive", "seq": 1, "throttle": 0.3, "steer": 0 },
    "everyMs": 100, "untilUs": 5000000 },
  { "tUs": 6000000, "port": 3333, "line": "not json, sent verbatim" }
]
```

`message` is checked against the control-protocol client schema; `line` is sent as is. `everyMs` with `untilUs` repeats an entry (a repeated `drive` has its `seq` raised each time), the way a client resends a held stick against the 500 ms failsafe. The car's replies are read and kept in `ControlledSource.received`.

Live TCP is the one input hal can't make deterministic (the hal README says so). A script over loopback is as close as it gets: every write is flushed to the firmware's socket before the `STEP` that follows it.
