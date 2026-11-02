import type { Track } from '@rcsim/schema';
import {
  finishLineOf,
  leftOf,
  sampleCentreline,
  type FinishLine,
  type Point2,
} from './track-geometry.ts';

/**
 * Counts laps by watching the car cross the start/finish line in the
 * direction of travel. The line is square to the track at the track's
 * `startFinish` point.
 *
 * A crossing counts only after the car has travelled at least half a lap
 * since the last counted one (or since the run began). That keeps a car that
 * starts just behind the line, or one that jitters across it, from scoring.
 */
export class LapCounter {
  readonly lapTimesUs: number[] = [];
  readonly #line: FinishLine;
  readonly #halfWidthM: number;
  readonly #minTravelM: number;
  #previous: Point2 | undefined;
  #side = 0;
  #travelledM = 0;
  #lastLapUs = 0;

  constructor(track: Track) {
    const sampled = sampleCentreline(track);
    this.#line = finishLineOf(track, sampled);
    this.#halfWidthM = track.widthM / 2;
    this.#minTravelM = sampled.lengthM / 2;
  }

  get count(): number {
    return this.lapTimesUs.length;
  }

  /** Feed the car's ground position after each tick. Returns true when a lap just completed. */
  update(position: Point2, nowUs: number): boolean {
    if (this.#previous) {
      this.#travelledM += Math.hypot(position.x - this.#previous.x, position.z - this.#previous.z);
    }
    this.#previous = position;

    const { point, direction } = this.#line;
    const rx = position.x - point.x;
    const rz = position.z - point.z;
    const along = rx * direction.x + rz * direction.z;
    const left = leftOf(direction);
    const across = rx * left.x + rz * left.z;
    const side = along < 0 ? -1 : 1;
    const crossed = this.#side < 0 && side > 0 && Math.abs(across) <= this.#halfWidthM;
    this.#side = side;
    if (!crossed || this.#travelledM < this.#minTravelM) return false;

    this.lapTimesUs.push(nowUs - this.#lastLapUs);
    this.#lastLapUs = nowUs;
    this.#travelledM = 0;
    return true;
  }
}
