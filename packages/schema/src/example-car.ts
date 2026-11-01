import defaultCar from '../examples/default-car.json' with { type: 'json' };
import { Car } from './car.ts';

/**
 * The full default car: three VL53L0X sensors at the front, an MPU6050, the
 * steering servo, the ESC and motor, and a battery divider on an ADC1 pin.
 * New car projects start from it.
 */
export const exampleCar: Car = Car.parse(defaultCar);
