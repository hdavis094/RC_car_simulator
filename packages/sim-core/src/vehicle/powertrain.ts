import type { MotorParams } from './params.ts';

/** The battery pack as the motor sees it. */
export interface Pack {
  /** Voltage with no current drawn, volts. */
  readonly openCircuitV: number;
  /** Internal resistance of the pack and its wiring, ohms. */
  readonly resistanceOhm: number;
}

export interface MotorLoad {
  /** Motor shaft torque, N·m, signed like the duty. */
  readonly torqueNm: number;
  /** Pack terminal voltage under this load, volts. */
  readonly packV: number;
  /** Current drawn from the pack, amps (never negative). */
  readonly packCurrentA: number;
}

/**
 * The winding resistance, ohms, that gives the part's stall torque at its
 * nominal voltage: with torque constant 1/Kv (N·m/A), stall current is
 * torque × Kv.
 */
const windingOhm = (motor: MotorParams): number =>
  motor.nominalV / (motor.stallTorqueNm * motor.kvRadPerSV);

/**
 * A brushed motor on a PWM controller and a pack with internal resistance,
 * solved in the steady state for this instant (no inductance, no capacitance):
 *
 *   motor current  Im = (duty × V − ω / Kv) / R
 *   pack current   Ib = duty × Im
 *   pack voltage   V  = Voc − r × Ib
 *   torque         T  = Im / Kv
 *
 * Braking current is not fed back into the pack: when Ib would be negative
 * the pack stays at its open-circuit voltage. Zero duty is open circuit.
 */
export function motorLoad(
  motor: MotorParams,
  pack: Pack,
  duty: number,
  speedRadS: number,
): MotorLoad {
  const { openCircuitV: voc, resistanceOhm: r } = pack;
  if (duty === 0) return { torqueNm: 0, packV: voc, packCurrentA: 0 };
  const R = windingOhm(motor);
  const backEmfV = speedRadS / motor.kvRadPerSV;
  let motorA = (duty * voc - backEmfV) / (R + r * duty * duty);
  let packA = duty * motorA;
  if (packA < 0) {
    motorA = (duty * voc - backEmfV) / R;
    packA = 0;
  }
  return {
    torqueNm: motorA / motor.kvRadPerSV,
    packV: Math.max(0, voc - r * packA),
    packCurrentA: packA,
  };
}

/**
 * The torque (a magnitude, N·m) of a motor the ESC shorts for `strength`
 * (0..1) of the time: its back-EMF drives current through the winding, which
 * opposes the rotation and takes nothing from the pack. It fades with speed.
 */
export function brakeTorqueNm(motor: MotorParams, strength: number, speedRadS: number): number {
  const amps = (strength * Math.abs(speedRadS)) / motor.kvRadPerSV / windingOhm(motor);
  return amps / motor.kvRadPerSV;
}
