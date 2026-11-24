# Vehicle physics

`sim-core` has two vehicle models, chosen per run by `physicsStage` (`RunOptions`, `ScenarioSpec`, `rcsim run --physics-stage <1|2>`). **Stage 1 is the default.** All values below are SI unless a unit is given; part files use mm, g and mΩ and are converted on the way in.

|                       | Stage 1                          | Stage 2                                     |
| --------------------- | -------------------------------- | ------------------------------------------- |
| Centre of gravity     | the chassis part's               | chassis plus placed part masses             |
| Tyres                 | Rapier's vehicle controller      | slip-angle force inside a friction circle   |
| Pack voltage          | nominal, constant                | sags under motor load                       |
| ESC, pulses back      | reverse (nothing if disabled)    | brake first, reverse on the second push     |
| Battery ADC readings  | 10 Hz                            | 100 Hz                                      |

Both stages share the rigid body, the Rapier ray-cast suspension, the body collider, Ackermann steering, rolling resistance, servo model, and ESC arming, deadband and throttle curve.

Both are deterministic: time comes from the tick, nothing in the vehicle is random, and a run is bit-identical for the same inputs (checked by golden snapshot hashes for each stage).

## Shared parameters

| Parameter                                 | Value | Dimension                                    |
| ----------------------------------------- | ----- | -------------------------------------------- |
| Gravity                                   | 9.81  | m/s²                                         |
| Suspension rest length, maximum travel    | 0.03  | m                                            |
| Suspension stiffness (per unit car mass)  | 200   | 1/s² (force = stiffness × compression × mass) |
| Compression, relaxation damping           | 10, 12 | 1/s (per unit car mass)                     |
| Maximum suspension force per wheel        | 2000  | N                                            |
| Rolling resistance                        | 0.08  | N per N of wheel load                        |
| Body underside clearance                  | 0.04  | m                                            |
| Body friction coefficient                 | 0.2   | dimensionless                                |

Stage 1 takes rolling resistance from each wheel's load at rest, stage 2 from its load now. Stage 1's tyres use Rapier's friction slip 1.5 and side stiffness 1 (dimensionless).

## Stage 2

### Mass and centre of gravity

The car weighs the chassis plus every part in `car.json`, in both stages.

- A part with a `placement` is a **point mass** at its mount point plus offset, in the chassis frame. Placement angles do not matter.
- A part without one counts as part of the chassis: its mass sits at the chassis' `centreOfGravityMm`.
- The centre of gravity is the mass-weighted mean of the two.
- Rotational inertia (kg·m²) is a uniform box of the chassis' overall dimensions, carrying the chassis and unplaced mass and centred on the chassis' centre of gravity, plus each point's parallel-axis term. Products of inertia are neglected.

Each wheel's static load follows from the centre of gravity, so moving the battery rearward gives a rear-drive car more traction. If a placement puts the centre of gravity outside the wheels, the share of the unloaded side is clamped to zero.

### Tyres

Rapier's controller finds the ground and pushes the car up; its own friction is switched off. For each wheel touching the ground, with load `N` (the suspension force, N), the contact point's velocity is split into `v_f` along the wheel's heading and `v_r` to its right (m/s):

- slip angle `α = atan2(v_r, max(|v_f|, v_min))`
- lateral force `min(C × |α|, μ) × N`, against `v_r`
- longitudinal force: the motor's share on a driven wheel, less rolling resistance and brake, which oppose `v_f`
- **friction circle:** the combined force is at most `μ × N`. Asking for more gives understeer or oversteer, wheelspin, or a locked wheel.

| Parameter                               | Value | Dimension                    |
| --------------------------------------- | ----- | ---------------------------- |
| `μ`, peak friction                      | 0.9   | dimensionless (N per N)      |
| `C`, cornering stiffness per unit load  | 8     | 1/rad                        |
| `v_min`, slip-angle speed floor         | 0.3   | m/s                          |

The force saturates at `α = μ / C` ≈ 0.11 rad. The values are estimates for rubber tyres on a smooth floor.

For stability at any tick length, neither the lateral force nor the resistance may reverse the velocity it opposes. The limit uses the mass the contact point has to move, `1 / (1/m + (r × d)ᵀ I⁻¹ (r × d))` for a unit direction `d` at arm `r`, divided by the number of wheels touching. All four impulses are computed from the same velocities before any is applied.

### Motor and battery

The motor is brushed, driven by PWM, and solved in the steady state each tick:

| Symbol | Meaning                 | From                                                     | Dimension  |
| ------ | ----------------------- | -------------------------------------------------------- | ---------- |
| `Kv`   | speed constant          | `kvRpmPerV` × 2π / 60                                    | rad/(s·V)  |
| `R`    | winding resistance      | `V_nom / (maxTorqueNm × Kv)`                             | Ω          |
| `V_oc` | open-circuit voltage    | `cells × cellNominalV` (7.4 V with no battery part)      | V          |
| `r`    | pack resistance         | `internalResistanceMohm` / 1000 (0 with no battery part) | Ω          |
| `ω`    | motor speed             | forward speed / wheel radius × `finalDriveRatio`         | rad/s      |
| `d`    | duty after the ESC      | −1..1                                                    | dimensionless |

- motor current `I_m = (d × V − ω / Kv) / R` (A)
- pack current `I_b = d × I_m` (A)
- pack voltage `V = V_oc − r × I_b` (V)
- shaft torque `T = I_m / Kv` (N·m), split equally between the driven wheels through the final drive

With `r = 0` this is stage 1's straight torque line. For the default car, a standing start at full throttle draws about 52 A and pulls the pack from 7.4 V to 6.8 V, which the 100 kΩ / 33 kΩ divider shows the ADC as 1.68 V instead of 1.84 V.

The sag reaches the firmware through the voltage divider, which reads the **first battery** in `car.json` (as in stage 1, whatever its `IN` pin is wired to). The reading follows the voltage of the latest tick, sampled at 100 Hz.

### ESC: brake, then reverse

Once armed:

| Push                                                     | Result                              |
| -------------------------------------------------------- | ----------------------------------- |
| forward                                                  | drive; the next push back brakes    |
| back, first time                                         | brake, however long it is held      |
| neutral for at least one PWM frame, then back again      | reverse                             |
| neutral, then back, while already reversing              | reverse                             |
| back, with `reverse: false`                              | brake, every time                   |

Losing the signal disarms the ESC and forgets the taps. Pushes before arming count for nothing.

**Braking** shorts the motor for `|d|` of the time: it resists rotation with `|d| × |ω| / (Kv² × R)` (N·m), takes nothing from the pack, fades with speed and never drives the car backwards. In the vehicle command it is a negative `motorDuty` with `brake: true`.

## Not modelled

- **Wheel and drivetrain inertia.** Motor speed is the car's speed. Under wheelspin or wheel lock the real motor speeds up or stops with the wheel, so wheelspin current and sag are upper bounds.
- **Motor-speed feedback in the ESC.** The second push back reverses even if the car is still rolling forward (the motor then brakes hard against its rotation). A real ESC may keep braking until the motor stops.
- **State of charge.** The pack never runs down; `capacityMah`, `cellFullV`, `cellEmptyV` and `maxContinuousC` are unused.
- **Other loads.** Only the motor sags the pack; servo, controller and sensor current are left out. Braking does not charge it.
- **Inductance and capacitance**, so no switching ripple or spikes, and no ESC or motor current limit.
- **Tyre compound, temperature and load sensitivity.** `μ` is the same on every surface and at every load.
- **Static friction on slopes.** A car parked across a slope creeps sideways, at about `tan(slope) × v_min / C` (a few mm/s at 10°).
