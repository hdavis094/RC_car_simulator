import type { ActuatorOutput } from '../api/actuators.ts';
import type { VehicleCommand } from '../api/vehicle.ts';

// Physics stage 2 has to tell an ESC that is braking from one driving in
// reverse: both are a negative duty. The contracts have no field for it yet
// (docs/tasks/P3-03 → Contract change requests), so these types add the one
// requested. It is set only while braking, so stage-1 data is unchanged.

/** The ESC shorts the motor: `motorDuty` is then the brake strength, and never drives. */
interface Brake {
  readonly brake?: boolean;
}

export type DriveCommand = VehicleCommand & Brake;
export type DriveOutput = Extract<ActuatorOutput, { kind: 'drive' }> & Brake;
