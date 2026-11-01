# sim-protocol, version 1

This is the binary protocol between `sim-core` (the **sim**) and one firmware process (the **firmware**, built against `hal`). It carries the lockstep clock, sensor readings, GPIO edges, serial bytes and network events ([ARCHITECTURE.md → Lockstep time](../../docs/ARCHITECTURE.md#lockstep-time)). The TypeScript codec in `src/` and the golden vectors in `vectors/` are the reference: hal (C++) must encode and decode the vector bytes exactly.

## Transport

- A Unix domain stream socket. **The sim is the server.** It creates the socket, listens, and starts the firmware with the socket path in the environment variable `RCSIM_SOCKET`. The firmware connects once at startup.
- The path is under `/tmp` and shorter than 100 bytes (macOS caps `sun_path` at 104), for example `/tmp/rcsim-<pid>-<n>.sock`.
- One socket connection carries one firmware process. A firmware restart (a crash, or a simulated reboot) is a new connection within the same run.

## Framing

Every message is one frame:

```
u32 length   number of bytes that follow (type + payload), little-endian
u8  type     message type
...          payload, layout fixed by the type
```

- `length` is at least 1 and at most **1 048 576** (1 MiB).
- The payload must be consumed exactly: trailing bytes are a malformed frame.
- There is no padding and no alignment. Frames follow one another directly on the stream.

## Primitive types

All multi-byte values are **little-endian**.

| Type | Encoding |
|---|---|
| `u8`, `u16`, `u32`, `u64` | unsigned integers, 1/2/4/8 bytes. A `u64` must not exceed 2⁵³ − 1; a larger value is malformed (this keeps every value exact in JavaScript, and 2⁵³ µs is 285 years). |
| `f32` | IEEE 754 binary32, finite only: NaN and ±Infinity are malformed |
| `bool` | `u8`, 0 or 1; any other value is malformed |
| `string` | `u16` byte length, then UTF-8 bytes (no terminator). Invalid UTF-8 is malformed. Bytes are kept exactly, a leading BOM included. |
| `bytes` | `u32` length, then raw bytes |
| `array<T>` | `u16` count, then `count` elements of `T` |
| `optional<T>` | `u8` 0 (absent) or 1 (present, followed by `T`); other values are malformed |
| `enum` | `u8`; values not listed here are malformed |

Times are **µs of sim time as `u64`**. Sim time belongs to the run: it starts at 0 when the run starts and carries on across firmware restarts.

## Limits

A frame that exceeds any limit is malformed.

| What | Limit |
|---|---|
| frame `length` | 1 048 576 bytes |
| `string` | 1024 bytes |
| `array` elements | 4096 |
| serial bytes per message (`serialRx`, `serialTx`) | 16 384 |
| log lines per `STEP_DONE` | 256 |

## Connection

```
firmware                         sim
   │── HELLO ───────────────────►│   protocol and hal versions
   │◄─────────────────── CONFIG ─│   or BYE(version-mismatch)
   │◄─────────────────── STEP 0 ─│   firmware runs setup(), then loop()
   │── STEP_DONE 0 ─────────────►│
   │◄─────────────────── STEP 1 ─│
   │── STEP_DONE 1 ─────────────►│
   │            …                │
   │◄────────────── BYE / BYE ──►│   either side, at any time after HELLO
```

1. The firmware connects and sends `HELLO`.
2. If the sim supports `HELLO.protocolVersion`, it replies `CONFIG`. Otherwise it sends `BYE(version-mismatch)` and closes.
3. The sim sends `STEP n` (`n` = 0, 1, 2, …). The firmware runs user code: `setup()` during step 0, then `loop()` repeatedly. It keeps going until its virtual clock reaches `STEP.t1Us`, then replies `STEP_DONE n` and blocks until the next `STEP`. Exactly one `STEP_DONE` answers each `STEP`, in order, and the sim never sends `STEP n+1` before receiving `STEP_DONE n`.
4. Either side may send `BYE` and then close. A side that receives a malformed frame sends `BYE(malformed)` with a reason, then closes. An unexpected message for the current state, such as `STEP` before `CONFIG`, also counts as malformed.

The sim detects a stall (no `STEP_DONE` within its wall-clock timeout, 2 s by default). It then sends `BYE(stalled)` and kills the firmware process.

### Virtual time

hal keeps a virtual clock `v`, in ns, that runs continuously across steps:

- `delay()` and `delayMicroseconds()` advance `v` exactly by their duration.
- Every other hal call advances `v` by `CONFIG.halCallCostNs`, and every return from `loop()` by `CONFIG.loopCostNs`.
- **`v` never passes the step's end.** When an advance would take `v` past `t1Us`, `v` stops at `t1Us`. The remainder is carried, and hal sends `STEP_DONE` without returning to user code. The next `STEP` consumes the carried remainder first, so a `delay(100)` spans 100 one-ms steps and returns in the step where it ends. Fractional ns carry the same way.
- So `v` equals `t0Us` at the start of every step and `t1Us` at every `STEP_DONE`. `setup()` and any `loop()` iteration may span many steps.
- `micros()` and `millis()` count from the firmware's own start, as after a real power-on or reboot: `micros()` = ⌊(v − t0Us of its first STEP) / 1000⌋, and `millis()` = ⌊micros() / 1000⌋.

### When things happen

- The sim applies `STEP_DONE n` (PWM, GPIO writes) to tick n, then advances physics through tick n. It computes the readings parts produce during tick n, and sends them in `STEP n+1`. **A reading therefore reaches the firmware one tick after it is produced**, with `STEP n+1.t0Us − tickUs ≤ tUs < STEP n+1.t0Us`. `STEP 0` carries the parts' power-on readings, if any, at `tUs = 0`.
- `STEP n.gpioEdges` are input edges inside tick n (`t0Us ≤ tUs < t1Us`), which hal applies at their timestamps while user code runs. Edges caused by firmware output, such as an HC-SR04 echo after its trigger, fall in later ticks.

## Messages

| Type | Name | Direction |
|---|---|---|
| `0x01` | `HELLO` | firmware → sim |
| `0x02` | `CONFIG` | sim → firmware |
| `0x03` | `STEP` | sim → firmware |
| `0x04` | `STEP_DONE` | firmware → sim |
| `0x05` | `BYE` | either |

Any other type byte is malformed.

### `HELLO` (0x01)

| Field | Type | Meaning |
|---|---|---|
| `protocolVersion` | `u16` | This document's version: **1** |
| `halVersion` | `string` | hal's version, for logs |

### `CONFIG` (0x02)

| Field | Type | Meaning |
|---|---|---|
| `protocolVersion` | `u16` | The version the connection uses (equal to `HELLO`'s) |
| `tickUs` | `u32` | Length of one tick, normally 1000 |
| `seed` | `u32` | The run's seed, for any randomness hal needs (none in v1) |
| `halCallCostNs` | `u32` | Virtual time each hal call costs, normally 1000 |
| `loopCostNs` | `u32` | Virtual time each `loop()` return costs, normally 5000 |
| `net` | `NetConfig` | Where firmware sockets bind |
| `devices` | `array<Device>` | Every part hal must present, in `car.json` order |

`NetConfig`:

| Field | Type | Meaning |
|---|---|---|
| `bindAddress` | `string` | Host address for listening sockets: `127.0.0.1` by default, or a LAN address |

`Device`:

| Field | Type | Meaning |
|---|---|---|
| `instanceId` | `string` | The part's `car.json` instance id, e.g. `tof_left` |
| `kind` | `string` | The hal model of the part (table below) |
| `pins` | `array<DevicePin>` | The part's GPIO-wired pins |
| `defaultI2cAddress` | `u8` | Address at power-on; 0 if not an I²C device |
| `targetI2cAddress` | `u8` | Address `car.json` expects the firmware to set; 0 if not I²C |

`DevicePin`: `name: string` (the part pin, e.g. `XSHUT`), `gpio: u8`.

**A device is referred to by its index** in `devices` (0-based, `u16`) in every later message.

Device kinds in v1:

| `kind` | Part | Readings | How firmware sees it |
|---|---|---|---|
| `vl53l0x` | `sensor.vl53l0x-pololu` | `DISTANCE` | `pololu/VL53L0X` shim on `Wire`. Boots at `defaultI2cAddress` and answers only while XSHUT is high. |
| `mpu6050` | `sensor.gy-521-mpu6050` | `IMU` | `electroniccats/MPU6050` shim on `Wire` |
| `hc-sr04` | `sensor.hc-sr04` | none | GPIO only: firmware writes TRIG; the sim answers with ECHO edges in `STEP.gpioEdges` |
| `servo` | `actuator.mg996r` | none | firmware PWM on SIGNAL, reported in `STEP_DONE.pwm` |
| `esc` | `actuator.quicrun-1060-540` | none | as `servo` |
| `analog` | anything on an ADC pin, e.g. a battery divider | `ANALOG` | `analogRead()` / `analogReadMilliVolts()` on its pin |

The sim decides the kind from the part definition. Parts hal doesn't model (the battery, the regulator) are not listed.

### `STEP` (0x03)

| Field | Type | Meaning |
|---|---|---|
| `tick` | `u64` | Tick index of the run, rising by 1. A restarted firmware's first `STEP` continues the run's numbering. |
| `t0Us` | `u64` | Run sim time at the start of the tick |
| `t1Us` | `u64` | Sim time at its end (`t0Us + tickUs`) |
| `readings` | `array<Reading>` | Readings produced during the previous tick, in device order, then by `tUs` |
| `gpioEdges` | `array<GpioEdge>` | Input edges the sim drives during this tick, ascending `tUs` |
| `serialRx` | `bytes` | Bytes arriving on `Serial` (UART0) during this tick |
| `netFaults` | `optional<NetFaults>` | Present only when the settings changed |

`Reading`:

| Field | Type | Meaning |
|---|---|---|
| `device` | `u16` | Index into `CONFIG.devices` |
| `tUs` | `u64` | When the part produced the reading, in the previous tick (see *When things happen*) |
| `type` | `enum` | `1` DISTANCE, `2` IMU, `3` ANALOG |
| … | | payload by type, below |

- `DISTANCE` (1): `mm: u16` and `status: enum`. Status `0` is a valid range; `1` means no target within range (hal reports the library's out-of-range value); `2` is a signal failure. `mm` is meaningful only when status is 0.
- `IMU` (2): `accel: f32 × 3` (x, y, z in m/s², gravity included), `gyro: f32 × 3` (x, y, z in rad/s), and `tempC: f32`. Axes are the **chip axes**. For a part placed with no rotation, chip +X is car right (+X), chip +Y is car forward (−Z), and chip +Z is car up (+Y). A level, resting car therefore reads `accel ≈ (0, 0, +9.81)`. hal converts to raw register counts at the configured full-scale range.
- `ANALOG` (3): `volts: f32`, the voltage on the device's ADC pin. hal converts it to counts as the ESP32 ADC would.

`GpioEdge`: `gpio: u8`, `tUs: u64`, `level: bool`. `level` is the input level from `tUs` onward.

`NetFaults` (applied by hal to firmware sockets):

| Field | Type | Meaning |
|---|---|---|
| `latencyUs` | `u32` | Added one-way delay |
| `lossPpm` | `u32` | Probability, in parts per million, that a datagram or segment is dropped (0–1 000 000) |
| `dropout` | `bool` | true: all firmware traffic is blocked until cleared |

### `STEP_DONE` (0x04)

| Field | Type | Meaning |
|---|---|---|
| `tick` | `u64` | The tick this answers |
| `pwm` | `array<PwmOutput>` | PWM channels whose output **changed** during the tick |
| `gpioWrites` | `array<GpioWrite>` | Output level changes, ascending `tUs` |
| `serialTx` | `bytes` | Bytes written to `Serial` |
| `netEvents` | `array<NetEvent>` | Socket events |
| `logs` | `array<LogLine>` | hal diagnostics (not firmware serial output) |

- `PwmOutput`: `gpio: u8`, `periodUs: u32`, `pulseUs: u32`. `periodUs = 0` means the output stopped (`detach()`). The last reported value holds until the next one.
- `GpioWrite`: `gpio: u8`, `tUs: u64`, `level: bool`.
- `LogLine`: `level: enum` (`0` debug, `1` info, `2` warn, `3` error) and `text: string`.
- `NetEvent`: `type: enum` and a payload:
  - `1` LISTEN: `proto: enum` (`0` tcp, `1` udp), `firmwarePort: u16`, `hostPort: u16`, `bindAddress: string`. The firmware's server is reachable at `bindAddress:hostPort`.
  - `2` UNLISTEN: `proto: enum`, `firmwarePort: u16`.
  - `3` CONNECT: `firmwarePort: u16`, `peer: string` (`address:port`). A client connected to a firmware server.
  - `4` DISCONNECT: `firmwarePort: u16`, `peer: string`.

### `BYE` (0x05)

| Field | Type | Meaning |
|---|---|---|
| `reason` | `enum` | `0` normal, `1` version-mismatch, `2` malformed, `3` stalled, `4` shutdown (the sim is stopping), `5` firmware-exit (`exit()` or a fatal hal error) |
| `message` | `string` | Human-readable detail |

## Golden vectors

`vectors/<name>.bin` holds one complete frame (length prefix included). `vectors/<name>.json` holds the same message decoded:

```json
{ "type": "STEP", "message": { … } }
```

- Field names in the JSON are the ones in this document.
- `bytes` fields are arrays of numbers.
- Every `f32` value in a vector is exactly representable in binary32, so both directions are byte-identical.

`vectors/malformed/<name>.bin` holds frames that a decoder must reject, and `vectors/malformed/<name>.json` gives `{ "error": "<reason>" }`.

Implementations must:
1. decode each `.bin` to exactly the `.json` message;
2. encode each `.json` message to exactly the `.bin` bytes;
3. reject every malformed frame.

The TypeScript tests do all three. hal's tests (P1-C) must do the same in C++.

## Changes

A change to any layout bumps the version. A peer receiving a `HELLO` with a version it doesn't support replies `BYE(version-mismatch)`.
