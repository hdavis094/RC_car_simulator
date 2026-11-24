# Network fault injection

Donkey Car Simulator lets you inject deterministic network latency, packet loss, and full dropout into an active simulation run from **3D World** so you can verify firmware failsafe and reconnection behavior before deploying to an ESP32.

## How it works

1. **3D World** displays the **Network faults** bar (`Latency (ms)`, `Loss (%)`, `Dropout`, **Apply**, and **Reset**) together with a live availability indicator.
2. Submitting settings converts UI units to integer `sim-protocol` values and invokes `run.setNetFaults(faults)` over Electron IPC:
   - `latencyUs`: integer microseconds (`0` to `4294967295`, converted via `Math.round(latencyMs * 1000)`).
   - `lossPpm`: integer parts per million (`0` to `1000000`, converted via `Math.round(lossPercent * 10000)`).
   - `dropout`: boolean (`true` blocks all simulated firmware socket traffic until cleared).
3. `SimService` validates the integer bounds and boolean flag at the IPC boundary (`[rcsim:invalid]` on bad input, `[rcsim:no-run]` when no run is active, `[rcsim:busy]` while starting) and forwards the settings to `SimHost` in the utility process.
4. `SimHost` calls `Run.setNetFaults(faults)`, which attaches `STEP.netFaults` to the next lockstep tick sent to `hal`.
5. `hal` applies latency, loss, and dropout to simulated `WiFiClient`, `WiFiServer`, and `WiFiUDP` sockets using **sim time** and the run's **seed**:
   - Latency delays RX and TX packets by `latencyUs` of sim time (never wall time).
   - Packet loss draws from a PRNG seeded with `CONFIG.seed` so identical runs remain deterministic.
   - Dropout discards incoming traffic and blocks outgoing traffic and new `accept()` calls until cleared.

## Paused runs and reset

- Fault controls can only be applied while a run is **running** or **paused**.
- An edit submitted while **paused** does not advance the simulation; `Run` holds the latest settings and delivers them on the next **Step** or **Resume**.
- Clicking **Reset** restores `0 ms`, `0%`, and `Dropout: off` and sends `{ latencyUs: 0, lossPpm: 0, dropout: false }` to the active run.
- Stopping a run clears the UI back to default zero-fault settings because each new run starts without injected faults.

## Headless dropout scenario

The `scenarios/network-dropout*` scenario runs in the `pnpm test:scenarios` gate alongside the v1 scenario without altering seed-1 v1 acceptance:

- Builds the real **starter firmware** (`packages/firmware-template`).
- Sends a held manual `drive` stream (`throttle: 0.28`, `steer: -0.05`) every `50 ms` from `3.1 s` to `5.4 s` of sim time after the 3 s ESC arming gate completes.
- Injects `{ latencyUs: 0, lossPpm: 0, dropout: true }` at `4.010 s` of sim time (just after the `4.000 s` drive command is received).
- Proves that:
  1. Non-neutral manual drive (`1640 µs` ESC, `1475 µs` steering) and forward motion (`distanceM > 0.5`, `maxSpeedMps > 0.5`, `collisions == 0`) occur before the dropout.
  2. Drive stays active during the first `400 ms` of dropout.
  3. The manual **failsafe** neutralizes both ESC and steering to `1500 µs` and logs `failsafe: no drive for 500 ms` on Serial after `500 ms` of sim time (`4.500 s`), holding neutral for the rest of the run despite continuing drive commands.
  4. Re-running with seed `1` produces identical PWM timing, `serialHash`, and `snapshotHash`.

Run it directly with:

```bash
node scenarios/network-dropout.ts
# or through the scenario gate:
pnpm test:scenarios
```

## Scope

Network fault injection applies only to simulated firmware sockets inside `hal`. It does not add network protocol fields and does not affect real-hardware ESP32 connections.
