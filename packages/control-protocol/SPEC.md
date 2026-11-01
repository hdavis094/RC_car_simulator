# Control protocol, version 1

The protocol between a laptop (the **client**: the app's `ControlClient`, the Network Console, any script) and the car's firmware (the **car**). It is the same on the real car and in the sim ([ADR 0004](../../docs/adr/0004-manual-drive-over-control-protocol.md)): in the sim, the firmware's listening socket is a real host socket that hal remaps to a free port and reports in a `LISTEN` net event.

## Transport

- TCP. **The car is the server**, on port **3333** by default.
- Each direction is a stream of **lines**: one JSON object per line, UTF-8, ended by `\n`. A `\r` before the `\n` is ignored.
- A line is at most **4096 bytes**, including the `\n`. A receiver discards a longer line and logs it.
- Every object has a string field `t`, the message type.

The car accepts one client at a time. When a second client connects, the car drops the first: the newest controller wins.

## Messages

### Car → client

**`hello`**, sent once, immediately on connect:

```json
{"t":"hello","name":"Default car","fw":"0.1.0","proto":1}
```

| Field | Type | Meaning |
|---|---|---|
| `name` | string | The car's name (`car.json` `name`) |
| `fw` | string | Firmware version |
| `proto` | integer | This protocol's version: **1** |

**`telemetry`**, about **20 Hz** (every 50 ms):

```json
{"t":"telemetry","ms":1234,"mode":"auto","estop":false,"throttle":0.3,"steer":0.1,
 "tof_mm":[812,1200,640],"batt_mv":7810,"yaw_dps":12.5}
```

| Field | Type | Meaning |
|---|---|---|
| `ms` | integer | Car uptime, `millis()` |
| `mode` | `"manual"` \| `"auto"` | Current mode |
| `estop` | boolean | E-stop is latched |
| `throttle` | number, −1..1 | Throttle being applied now (0 after failsafe or e-stop) |
| `steer` | number, −1..1 | Steering being applied now; −1 is full left |
| `tof_mm` | integer[] (optional) | Distance sensors, left to right; 0 means no target in range |
| `batt_mv` | integer (optional) | Battery voltage, mV |
| `yaw_dps` | number (optional) | Yaw rate in °/s, positive turning left |

The optional fields depend on which parts the car has.

**`log`**: `{"t":"log","msg":"failsafe: no drive for 500 ms"}`. Human-readable firmware messages.

### Client → car

**`drive`**: `{"t":"drive","seq":12,"throttle":0.4,"steer":-0.2}`

| Field | Type | Meaning |
|---|---|---|
| `seq` | integer, 0..2³²−1 | Rises by 1 per command and wraps to 0 after 2³²−1. The car ignores a `drive` whose `seq` is not newer than the last it applied: *newer* means `(seq − last) mod 2³²` is in 1..2³¹. A new connection starts afresh. |
| `throttle` | number | −1 full reverse/brake … 0 stop … 1 full forward; clamped to −1..1 |
| `steer` | number | −1 full left … 1 full right; clamped to −1..1 |

**`mode`**: `{"t":"mode","mode":"manual"}` or `"auto"`. It switches mode and **clears an e-stop**.

**`estop`**: `{"t":"estop"}`. The car stops at once (throttle 0) in any mode and latches the e-stop. While latched it ignores `drive` and does not drive itself. Only a `mode` message clears it.

## Car behaviour

- **Boot**: manual mode, not e-stopped, throttle 0, steering centred.
- **Manual mode**: the car applies each new `drive`.
- **Failsafe**: in manual mode, if no `drive` has arrived for **500 ms**, the car sets throttle 0 and centres the steering, and logs it once. The next `drive` resumes control. A client holding the stick must therefore repeat its command; `ControlClient` resends it every 100 ms.
- **Auto mode**: the car drives itself from its sensors and ignores `drive`.
- **Disconnect**: the same as no `drive` arriving, so failsafe applies in manual mode. Auto mode carries on.

## Robustness rules

- **Unknown fields** are ignored, so newer peers can add fields.
- **An unknown `t`**, a line that isn't a JSON object, or a missing required field is ignored, and the receiver logs it. A car logs with a `log` message; `ControlClient` emits an `unknown` event. The connection stays open.
- Numbers outside their range are clamped (`throttle`, `steer`). Non-numbers make the message invalid.

## Versioning

`hello.proto` carries the version. A client that doesn't support it should warn and may still try. Adding optional fields and new message types does not change the version; changing the meaning of an existing field does.
