# P0-04 — Contract: sim-protocol and control protocol

Status: in-progress
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

- [ ] `pnpm verify` passes
- [ ] every sim-protocol message has golden vectors, and the TS codec round-trips them byte-identically
- [ ] the control client passes connect / drive / telemetry / reconnect / failsafe-timing tests against the fake car

## Out of scope

The C++ side of either protocol (P1-C, P1-G); the sim-side bridge (P1-H).

## Handoff

- **Built**:
- **Deviations from the brief**:
- **Open questions**:
