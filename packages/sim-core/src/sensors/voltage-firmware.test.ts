// The battery voltage all the way to compiled firmware: sag → divider → ADC.
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { defaultCatalog, exampleCar, World } from '@rcsim/schema';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PhysicsStage } from '../api/vehicle.ts';
import { createFirmwareSource } from '../bridge/firmware-source.ts';
import { createRun } from '../run/run.ts';
import { trackLibrary } from '../world/track-library.ts';

/** Full throttle once the ESC has armed, printing the battery pin every 20 ms. */
const SKETCH = `#include <Arduino.h>
#include <ESP32Servo.h>

Servo esc;

void setup() {
  Serial.begin(115200);
  analogReadResolution(12);
  esc.attach(26, 1000, 2000);
}

void loop() {
  esc.writeMicroseconds(millis() < 3500 ? 1500 : 2000);
  Serial.printf("%lu %u\\n", millis(), static_cast<unsigned>(analogReadMilliVolts(35)));
  delay(20);
}
`;

const buildSim = fileURLToPath(new URL('../../../hal/bin/build-sim', import.meta.url));
let project: string;
beforeAll(async () => {
  project = await mkdtemp(path.join(tmpdir(), 'rcsim-sag-'));
  await mkdir(path.join(project, 'src'));
  await writeFile(path.join(project, 'src', 'main.cpp'), SKETCH);
  await promisify(execFile)(process.execPath, [buildSim, project], { maxBuffer: 16 * 1024 * 1024 });
}, 120_000);
afterAll(() => rm(project, { recursive: true, force: true }));

/** The millivolts the firmware read, by its own clock, over 4.5 s. */
async function readByFirmware(physicsStage: PhysicsStage): Promise<{ ms: number; mv: number }[]> {
  const run = await createRun({
    car: exampleCar,
    catalog: defaultCatalog,
    world: World.parse({
      schemaVersion: 1,
      name: 'floor',
      trackId: 'oval',
      seed: 1,
      obstacles: [],
    }),
    track: { ...trackLibrary.load('oval'), wallHeightM: 0 },
    seed: 1,
    physicsStage,
    source: createFirmwareSource({ binary: path.join(project, '.rcsim', 'build', 'firmware') }),
  });
  const decoder = new TextDecoder();
  let text = '';
  run.on('serial', (bytes) => (text += decoder.decode(bytes, { stream: true })));
  try {
    await run.step(4500);
    expect(run.end).toBeNull();
  } finally {
    await run.stop();
  }
  return [...text.matchAll(/^(\d+) (\d+)\r?$/gm)].map((m) => ({
    ms: Number(m[1]),
    mv: Number(m[2]),
  }));
}

/** 7.4 V through the 100 kΩ / 33 kΩ divider. */
const NOMINAL_MV = (7400 * 33) / 133;

describe('battery voltage in firmware', () => {
  it('reads the sag under load in stage 2', async () => {
    const readings = await readByFirmware(2);
    const unloaded = readings.filter((r) => r.ms > 200 && r.ms < 3500);
    const loaded = readings.filter((r) => r.ms > 3500);
    for (const r of unloaded) expect(Math.abs(r.mv - NOMINAL_MV)).toBeLessThan(3);
    expect(unloaded.length).toBeGreaterThan(100);
    expect(Math.min(...loaded.map((r) => r.mv))).toBeLessThan(NOMINAL_MV - 70);
  }, 60_000);

  it('reads a steady voltage in stage 1', async () => {
    const readings = (await readByFirmware(1)).filter((r) => r.ms > 200);
    expect(readings.length).toBeGreaterThan(150);
    for (const r of readings) expect(Math.abs(r.mv - NOMINAL_MV)).toBeLessThan(3);
  }, 60_000);
});
