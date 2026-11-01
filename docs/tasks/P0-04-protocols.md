# P0-04 — Contract: sim-protocol and control protocol

Status: in-review
Agent: Claude (Opus)
Branch: ws/p0-04
Depends on: P0-02

## Goal

Two written, versioned protocols with reference codecs and golden vectors. With them, hal (C++) and sim-core (TS) can each be built and tested alone and still interoperate, and the app can drive any car, sim or real.

## Owned paths

`packages/sim-protocol/`, `packages/control-protocol/`

## Read first

`docs/ARCHITECTURE.md` (Lockstep time, Sensors and actuators, Wi-Fi, Control protocol), ADRs 0002–0004.

## Requirements

### sim-protocol

1. **`SPEC.md`**. Transport: a Unix domain socket whose path is given to the firmware in env `RCSIM_SOCKET`; the sim is the server. Framing: u32 little-endian length prefix + u8 message type + payload. All integers little-endian, times in µs as u64, no padding.
2. **Messages**:
   - `HELLO` (fw→sim: protocol version, hal version)
   - `CONFIG` (sim→fw: tick µs, seed, the device table, time-cost model values)
     - device table entries: instance id, kind, pins, default and target I²C address
   - `STEP` (sim→fw):
     - tick index, t0, t1
     - readings since the last step: device id + typed payload
     - GPIO input edges `{pin, tUs, level}`
     - serial RX bytes
     - net fault settings when changed
   - `STEP_DONE` (fw→sim):
     - tick index
     - PWM outputs `{pin, periodUs, pulseUs}`, sent only when changed
     - GPIO writes `{pin, tUs, level}`
     - serial TX bytes
     - net events, e.g. listen port mapped
     - debug log lines
   - `BYE` (either direction)
3. **Version negotiation and error handling**: a version mismatch or malformed frame closes the session with a reason.
4. **TS codec** (encode/decode for every message) with unit tests.
5. **Golden vectors** in `vectors/`: at least one `.bin` + `.json` pair per message type, including edge cases (empty arrays, maximum sizes). The TS tests round-trip them. P1-C must replay them in C++.

### control protocol

6. **`SPEC.md`**: newline-delimited JSON over TCP; default car port 3333.
   - **Messages**: `drive {seq, throttle, steer}` (both −1..1, clamped), `mode {manual|auto}`, `estop`, `telemetry` (fields as in ARCHITECTURE.md, ~20 Hz), `log`, and `hello` (the car's name and firmware version on connect).
   - **Rules**: unknown fields are ignored, unknown types are logged, and the failsafe is 500 ms in manual mode.
7. **TS client**: connect, send typed commands, emit parsed telemetry, reconnect with backoff. Unit-test it against an in-process fake car.

## Acceptance

- [x] `pnpm verify` passes
- [x] every sim-protocol message has golden vectors, and the TS codec round-trips them byte-identically
- [x] the control client passes connect / drive / telemetry / reconnect / failsafe-timing tests against the fake car

## Out of scope

The C++ side of either protocol (P1-C, P1-G); the sim-side bridge (P1-H).

## Handoff

- **Built**:
  - **sim-protocol** (`packages/sim-protocol`):
    - `SPEC.md` (v1) covers framing, primitive encodings, limits, the session flow, virtual-time rules, all five messages with every field, device kinds, and the golden-vector format.
    - TS codec: `encodeFrame`, `decodeFrame`, `decodeBody`, and a streaming `FrameDecoder` for socket chunks. It throws `ProtocolError` with a BYE reason.
    - `vectors/`: 15 golden `.bin`/`.json` pairs covering every message type. Edge cases include empty arrays, the 1024-byte string, 16384 serial bytes, 256 log lines and 2⁵³−1 times.
    - `vectors/malformed/`: 14 frames a decoder must reject. Tests check that each fails for its own reason, not just truncation.
    - Tests round-trip every vector byte-identically in both directions, check a hand-written HELLO layout, and decode a stream fed one byte at a time.
    - `pnpm --filter @rcsim/sim-protocol generate` regenerates the vectors from `scripts/vector-fixtures.ts`.
  - **control protocol** (`packages/control-protocol`):
    - `SPEC.md` (v1): JSON lines over TCP port 3333, plus robustness rules and the failsafe.
    - Zod message schemas, non-strict, so unknown fields are stripped. Plus `encodeLine`, `parseCarLine`/`parseClientLine`, `isNewerSeq` and a byte-safe `LineSplitter`.
    - `ControlClient`: connect, typed `drive`/`setMode`/`estop`, `hello`/`telemetry`/`log`/`unknown` events, and reconnect with exponential backoff. A held drive is resent every 100 ms.
    - `FakeCar`: a spec-faithful fake car. It is exported, so P1-D and P2-01 can test against it.
    - Tests cover connect, drive (clamp + seq), telemetry rate, unknown input, reconnect after a drop and while the car is absent, failsafe timing (held: none; released: 495–650 ms; dropout; auto mode) and the e-stop latch.
- **Deviations from the brief**:
  - **sim-protocol additions**:
    - `CONFIG` also carries `protocolVersion`, `halCallCostNs`, `loopCostNs` (ns rather than µs, so costs below 1 µs are possible) and `net.bindAddress`.
    - Devices are referred to by their index in `CONFIG.devices`.
    - Each reading carries `tUs`.
    - `BYE` has a reason enum: normal, version-mismatch, malformed, stalled, shutdown, firmware-exit.
    - The IMU reading is in chip axes, mapped to car axes in SPEC.md.
    - u64 values are limited to 2⁵³−1 in TS.
  - **Control protocol additions**:
    - `telemetry.estop`.
    - `drive.seq` wraparound rule: older commands are ignored.
    - E-stop latches until the next `mode`.
    - One client at a time; the newest wins.
    - The `tof_mm`, `batt_mv` and `yaw_dps` telemetry fields are optional.
  - **Session-state checks** (e.g. `STEP` before `CONFIG`) are specified, but enforcing them is left to the bridge (P1-H) and hal (P1-C). The codec only validates frames.
- **Contract change requests**: none (this is the contract).
- **Open questions**:
  - Device kinds are strings (`vl53l0x`, `mpu6050`, `hc-sr04`, `servo`, `esc`, `analog`). The mapping from part definition to kind lives in the bridge (P1-H); P0-05 may want it in the sim-core API.
