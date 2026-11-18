/// <reference types="node" />
// @vitest-environment jsdom
/* eslint-disable no-restricted-imports */
import { SCHEMA_VERSION, defaultCatalog, exampleCar, type World as WorldFile } from '@rcsim/schema';
import { createRun, createScriptedSource, trackLibrary } from '@rcsim/sim-core';
import { WHEEL_ORDER, type StateSnapshot } from '@rcsim/sim-core/api';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeRcsimApi } from '../../shared/fake-api.ts';
import { useSessionStore } from '../shell/session.ts';
import {
  SnapshotInterpolator,
  WorldRoot,
  computeCameraTransform,
  computeDriveFromGamepad,
  computeDriveFromKeys,
  generateTrackMeshData,
  getWorldThreeScene,
  interpolateSnapshots,
  screenToGroundPoint,
} from './index.ts';

beforeEach(() => {
  useSessionStore.setState(useSessionStore.getInitialState());
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function createFakeWithRealTracks() {
  return createFakeRcsimApi({
    tracks: {
      oval: trackLibrary.load('oval'),
      technical: trackLibrary.load('technical'),
    },
  });
}

describe('3D World environment (P1-F)', () => {
  it('poses the car body and all four wheels to match StateSnapshots fed from a real sim-core Run with a scripted ActuatorSource', async () => {
    const fake = createFakeWithRealTracks();
    const ovalTrack = trackLibrary.load('oval');
    const world: WorldFile = {
      schemaVersion: SCHEMA_VERSION,
      name: 'Test Oval',
      trackId: 'oval',
      seed: 42,
      obstacles: [],
    };

    // Real sim-core Run with a scripted PWM timeline (GPIO 26 = ESC, GPIO 25 = steering servo)
    const source = createScriptedSource([
      { tUs: 0, gpio: 26, pulseUs: 1500 }, // arm ESC at neutral for >= 3000 ms
      { tUs: 0, gpio: 25, pulseUs: 1500 },
      { tUs: 3_200_000, gpio: 26, pulseUs: 1780 }, // drive forward after arming
      { tUs: 3_200_000, gpio: 25, pulseUs: 1320 }, // steer left
    ]);

    const run = await createRun({
      car: exampleCar,
      catalog: defaultCatalog,
      world,
      track: ovalTrack,
      seed: 42,
      source,
    });

    try {
      render(<WorldRoot api={fake.api} />);

      // Step 1: initial snapshot at tick 0
      const snap0 = run.snapshot();
      act(() => {
        fake.emit.snapshot(snap0);
      });

      const assertCarAndWheelsMatchSnapshot = (snap: StateSnapshot) => {
        const scene = getWorldThreeScene();
        const carNode = scene.getObjectByName('car-body');
        expect(carNode).toBeDefined();
        expect(carNode!.position.x).toBeCloseTo(snap.car.pose.position[0], 6);
        expect(carNode!.position.y).toBeCloseTo(snap.car.pose.position[1], 6);
        expect(carNode!.position.z).toBeCloseTo(snap.car.pose.position[2], 6);
        expect(carNode!.quaternion.x).toBeCloseTo(snap.car.pose.rotation[0], 6);
        expect(carNode!.quaternion.y).toBeCloseTo(snap.car.pose.rotation[1], 6);
        expect(carNode!.quaternion.z).toBeCloseTo(snap.car.pose.rotation[2], 6);
        expect(carNode!.quaternion.w).toBeCloseTo(snap.car.pose.rotation[3], 6);

        const carDom = screen.getByTestId('car-mesh-pose');
        expect(Number(carDom.getAttribute('data-position-x'))).toBeCloseTo(
          snap.car.pose.position[0],
          6,
        );
        expect(Number(carDom.getAttribute('data-position-y'))).toBeCloseTo(
          snap.car.pose.position[1],
          6,
        );
        expect(Number(carDom.getAttribute('data-position-z'))).toBeCloseTo(
          snap.car.pose.position[2],
          6,
        );
        expect(Number(carDom.getAttribute('data-quat-x'))).toBeCloseTo(
          snap.car.pose.rotation[0],
          6,
        );
        expect(Number(carDom.getAttribute('data-quat-y'))).toBeCloseTo(
          snap.car.pose.rotation[1],
          6,
        );
        expect(Number(carDom.getAttribute('data-quat-z'))).toBeCloseTo(
          snap.car.pose.rotation[2],
          6,
        );
        expect(Number(carDom.getAttribute('data-quat-w'))).toBeCloseTo(
          snap.car.pose.rotation[3],
          6,
        );

        WHEEL_ORDER.forEach((wheelName, index) => {
          const expectedWheel = snap.car.wheels[index]!;
          const wheelNode = scene.getObjectByName(`wheel:${wheelName}`);
          expect(wheelNode).toBeDefined();
          expect(wheelNode!.position.x).toBeCloseTo(expectedWheel.position[0], 6);
          expect(wheelNode!.position.y).toBeCloseTo(expectedWheel.position[1], 6);
          expect(wheelNode!.position.z).toBeCloseTo(expectedWheel.position[2], 6);
          expect(wheelNode!.quaternion.x).toBeCloseTo(expectedWheel.rotation[0], 6);
          expect(wheelNode!.quaternion.y).toBeCloseTo(expectedWheel.rotation[1], 6);
          expect(wheelNode!.quaternion.z).toBeCloseTo(expectedWheel.rotation[2], 6);
          expect(wheelNode!.quaternion.w).toBeCloseTo(expectedWheel.rotation[3], 6);
        });
      };

      assertCarAndWheelsMatchSnapshot(snap0);

      // Step 2: advance 4000 ticks (4.0 s) so the car arms at 3.0 s, accelerates, and steers along the oval
      await run.step(4000);
      const snap1 = run.snapshot();
      expect(snap1.car.pose.position[2]).toBeLessThan(snap0.car.pose.position[2] - 0.5);
      expect(Math.abs(snap1.car.pose.rotation[1])).toBeGreaterThan(0.02);

      act(() => {
        fake.emit.snapshot(snap1);
      });
      assertCarAndWheelsMatchSnapshot(snap1);
      expect(screen.getByTestId('sim-time-display').textContent).toContain('4.000 s');

      // Step 3: advance another 600 ticks (to 4.6 s) and verify updated pose
      await run.step(600);
      const snap2 = run.snapshot();
      act(() => {
        fake.emit.snapshot(snap2);
      });
      assertCarAndWheelsMatchSnapshot(snap2);
      expect(screen.getByTestId('sim-time-display').textContent).toContain('4.600 s');

      // Verify 60 Hz interpolation between snap1 and snap2
      const mid = interpolateSnapshots(snap1, snap2, 0.5);
      expect(mid.car.pose.position[0]).toBeCloseTo(
        (snap1.car.pose.position[0] + snap2.car.pose.position[0]) / 2,
        6,
      );
      expect(mid.car.pose.position[2]).toBeCloseTo(
        (snap1.car.pose.position[2] + snap2.car.pose.position[2]) / 2,
        6,
      );

      const interp = new SnapshotInterpolator();
      interp.push({ ...snap1, status: 'running' }, 1000);
      interp.push({ ...snap2, status: 'running' }, 1020);
      const halfSample = interp.sample(1030)!;
      expect(halfSample.car.pose.position[2]).toBeCloseTo(mid.car.pose.position[2], 5);
    } finally {
      await run.stop();
    }
  });

  it('places a cone on the ground, rotates it, and includes it in the next world-edit save payload with the right position and yaw', async () => {
    const fake = createFakeWithRealTracks();
    const ovalTrack = trackLibrary.load('oval');
    render(<WorldRoot api={fake.api} />);

    await waitFor(() => {
      expect(screen.getByTestId('world-scene-telemetry').getAttribute('data-track-id')).toBe(
        'oval',
      );
    });

    // Switch to Top-down camera and select Cone from the palette
    fireEvent.click(screen.getByRole('button', { name: 'Top-down' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cone' }));

    // Compute what ground point a click at (clientX: 480, clientY: 240) hits in top-down view
    const trackMesh = generateTrackMeshData(ovalTrack);
    const camTransform = computeCameraTransform(
      'top-down',
      { position: [2.4, 0, 0.75], rotation: [0, 0, 0, 1] },
      trackMesh,
    );
    const expectedClickPoint = screenToGroundPoint(
      480,
      240,
      { left: 0, top: 0, width: 800, height: 600 },
      camTransform,
    )!;
    expect(expectedClickPoint).not.toBeNull();

    // Set initial placement yaw to 20 deg and click the ground at (480, 240)
    fireEvent.change(screen.getByLabelText('Placement yaw (deg)'), {
      target: { value: '20' },
    });
    const ground = screen.getByTestId('world-ground');
    fireEvent.pointerDown(ground, { button: 0, clientX: 480, clientY: 240 });
    fireEvent.pointerUp(ground);

    // Rotate the selected cone by +15 deg with '[' key -> 35 deg
    fireEvent.keyDown(window, { key: '[' });

    // Save the layout via world-edit IPC
    fireEvent.change(screen.getByLabelText('Layout path'), {
      target: { value: 'worlds/test-cone-layout.json' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save layout' }));

    await waitFor(() => {
      expect(fake.calls.some((c) => c.service === 'worldEdit' && c.method === 'save')).toBe(true);
    });

    const saveCall = fake.calls.find((c) => c.service === 'worldEdit' && c.method === 'save')!;
    expect(saveCall.args[0]).toBe('worlds/test-cone-layout.json');
    const savedWorld = saveCall.args[1] as WorldFile;
    expect(savedWorld.obstacles).toHaveLength(1);
    expect(savedWorld.obstacles[0]).toMatchObject({
      type: 'cone',
      positionM: {
        x: expectedClickPoint.x,
        z: expectedClickPoint.z,
      },
      yawDeg: 35,
    });

    // Feed the saved world into a real sim-core Run and emit its snapshot back to the renderer
    const run = await createRun({
      car: exampleCar,
      catalog: defaultCatalog,
      world: savedWorld,
      track: ovalTrack,
      seed: savedWorld.seed,
      source: createScriptedSource([]),
    });
    try {
      const snap = run.snapshot();
      expect(snap.obstacles).toHaveLength(1);
      expect(snap.obstacles[0]?.type).toBe('cone');
      expect(snap.obstacles[0]?.pose.position[0]).toBeCloseTo(expectedClickPoint.x, 5);
      expect(snap.obstacles[0]?.pose.position[2]).toBeCloseTo(expectedClickPoint.z, 5);

      act(() => {
        fake.emit.snapshot(snap);
      });

      const coneNode = getWorldThreeScene().getObjectByName(`obstacle:${snap.obstacles[0]!.id}`);
      expect(coneNode).toBeDefined();
      expect(coneNode!.position.x).toBeCloseTo(expectedClickPoint.x, 5);
      expect(coneNode!.position.z).toBeCloseTo(expectedClickPoint.z, 5);
    } finally {
      await run.stop();
    }
  });

  it('produces drive commands with expected throttle and steer signs on WASD/arrow keys at 50 Hz while manual, and sends mode and estop commands through control IPC', async () => {
    vi.useFakeTimers();
    const fake = createFakeWithRealTracks();
    render(<WorldRoot api={fake.api} />);

    // Verify pure sign helpers directly first
    expect(computeDriveFromKeys(new Set(['w']))).toEqual({ throttle: 1, steer: 0 });
    expect(computeDriveFromKeys(new Set(['s']))).toEqual({ throttle: -1, steer: 0 });
    expect(computeDriveFromKeys(new Set(['a']))).toEqual({ throttle: 0, steer: -1 });
    expect(computeDriveFromKeys(new Set(['d']))).toEqual({ throttle: 0, steer: 1 });
    expect(computeDriveFromKeys(new Set(['ArrowUp', 'ArrowLeft']))).toEqual({
      throttle: 1,
      steer: -1,
    });
    expect(computeDriveFromKeys(new Set(['ArrowDown', 'ArrowRight']))).toEqual({
      throttle: -1,
      steer: 1,
    });

    // Verify Gamepad API reading
    const padCommand = computeDriveFromGamepad(() => [
      {
        connected: true,
        axes: [-0.5, -0.8],
        buttons: [],
      } as unknown as Gamepad,
    ]);
    expect(padCommand).toEqual({ throttle: 0.8, steer: -0.5 });

    // Switch to Auto mode -> sends setMode('auto')
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Auto mode' }));
    });
    expect(
      fake.calls.some(
        (c) => c.service === 'control' && c.method === 'setMode' && c.args[0] === 'auto',
      ),
    ).toBe(true);

    // While in Auto mode, pressing W should not send drive commands
    const driveCountInAuto = fake.calls.filter(
      (c) => c.service === 'control' && c.method === 'drive',
    ).length;
    await act(async () => {
      fireEvent.keyDown(window, { key: 'w' });
      vi.advanceTimersByTime(60);
      fireEvent.keyUp(window, { key: 'w' });
    });
    expect(fake.calls.filter((c) => c.service === 'control' && c.method === 'drive').length).toBe(
      driveCountInAuto,
    );

    // Switch back to Manual mode -> sends setMode('manual')
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Manual mode' }));
    });
    expect(
      fake.calls.some(
        (c) => c.service === 'control' && c.method === 'setMode' && c.args[0] === 'manual',
      ),
    ).toBe(true);

    // Press W (forward: throttle > 0, steer = 0) and hold for 60 ms (50 Hz = every 20 ms)
    await act(async () => {
      fireEvent.keyDown(window, { key: 'w' });
      await Promise.resolve();
    });
    await act(async () => {
      vi.advanceTimersByTime(60);
      await Promise.resolve();
    });

    const forwardDrives = fake.calls
      .filter((c) => c.service === 'control' && c.method === 'drive')
      .map((c) => c.args[0] as { throttle: number; steer: number });
    expect(forwardDrives.length).toBeGreaterThanOrEqual(3);
    expect(forwardDrives.at(-1)).toEqual({ throttle: 1, steer: 0 });

    // Add Left steering ('a': steer < 0) while holding 'w'
    await act(async () => {
      fireEvent.keyDown(window, { key: 'a' });
      await Promise.resolve();
    });
    const forwardLeft = fake.calls
      .filter((c) => c.service === 'control' && c.method === 'drive')
      .map((c) => c.args[0] as { throttle: number; steer: number })
      .at(-1);
    expect(forwardLeft).toEqual({ throttle: 1, steer: -1 });

    // Release 'w' and 'a', press 's' (reverse: throttle < 0) and 'd' (right: steer > 0)
    await act(async () => {
      fireEvent.keyUp(window, { key: 'w' });
      fireEvent.keyUp(window, { key: 'a' });
      fireEvent.keyDown(window, { key: 's' });
      fireEvent.keyDown(window, { key: 'd' });
      await Promise.resolve();
    });
    const reverseRight = fake.calls
      .filter((c) => c.service === 'control' && c.method === 'drive')
      .map((c) => c.args[0] as { throttle: number; steer: number })
      .at(-1);
    expect(reverseRight).toEqual({ throttle: -1, steer: 1 });

    // Press Space for E-stop -> sends control.estop()
    await act(async () => {
      fireEvent.keyDown(window, { key: ' ', code: 'Space' });
      await Promise.resolve();
    });
    expect(fake.calls.some((c) => c.service === 'control' && c.method === 'estop')).toBe(true);
  });

  it('draws sensor beams with hit points, runs/pauses/steps/stops simulation, and displays Network Console telemetry and pretty-printed messages', async () => {
    const fake = createFakeWithRealTracks();
    render(<WorldRoot api={fake.api} />);

    // Emit a snapshot containing a distance sensor beam with a hit and lap/collision counts
    const snapWithBeams: StateSnapshot = {
      tick: 250,
      timeUs: 250_000,
      status: 'running',
      car: {
        pose: { position: [2.4, 0, -1.0], rotation: [0, 0, 0, 1] },
        velocity: [0, 0, -2.0],
        forwardSpeedMps: 2.0,
        command: { steerAngleRad: 0, motorDuty: 0.5 },
        wheels: WHEEL_ORDER.map((_, i) => ({
          position: [i % 2 === 0 ? 2.275 : 2.525, 0.054, i < 2 ? -1.167 : -0.833],
          rotation: [0, 0, 0, 1],
          steerRad: 0,
          spinRad: 1.2,
          inContact: true,
        })),
      },
      sensors: [
        {
          instanceId: 'tof_front',
          beams: [
            {
              origin: [2.4, 0.1, -1.28],
              direction: [0, 0, -1],
              maxRangeM: 1.2,
              hitM: 0.45,
            },
          ],
        },
      ],
      obstacles: [],
      laps: { count: 2, lapTimesUs: [12_000_000, 11_500_000] },
      collisions: { count: 1, last: 'wall' },
    };

    act(() => {
      fake.emit.snapshot(snapWithBeams);
    });

    expect(screen.getByTestId('lap-counter').textContent).toContain('2');
    expect(screen.getByTestId('collision-count').textContent).toContain('1 (wall)');
    const beamDom = screen.getByTestId('sensor-beam-tof_front:0');
    expect(beamDom.getAttribute('data-has-hit')).toBe('true');
    expect(Number(beamDom.getAttribute('data-end-z'))).toBeCloseTo(-1.28 - 0.45, 5);
    expect(getWorldThreeScene().getObjectByName('beam-hit:tof_front:0')).toBeDefined();

    // Run controls: start run, pause, step, change speed, stop
    fireEvent.change(screen.getByLabelText('Seed'), { target: { value: '7' } });
    fireEvent.click(screen.getByTestId('run-play-pause-btn'));
    await waitFor(() => {
      expect(screen.getByTestId('run-play-pause-btn').textContent).toBe('Pause');
    });

    // While running, obstacle palette buttons are disabled
    expect((screen.getByRole('button', { name: 'Cone' }) as HTMLButtonElement).disabled).toBe(true);

    // Pause run
    fireEvent.click(screen.getByTestId('run-play-pause-btn'));
    await waitFor(() => {
      expect(screen.getByTestId('run-play-pause-btn').textContent).toBe('Resume');
    });

    // Step while paused and change speed
    fireEvent.click(screen.getByTestId('run-step-btn'));
    fireEvent.change(screen.getByLabelText('Simulation speed'), {
      target: { value: '2' },
    });
    await waitFor(() => {
      expect(fake.calls.some((c) => c.service === 'run' && c.method === 'step')).toBe(true);
      expect(
        fake.calls.some((c) => c.service === 'run' && c.method === 'setSpeed' && c.args[0] === 2),
      ).toBe(true);
    });

    // Stop run
    fireEvent.click(screen.getByTestId('run-stop-btn'));
    await waitFor(() => {
      expect(screen.getByTestId('run-play-pause-btn').textContent).toBe('Run');
    });

    // Bottom dock: switch to Network Console tab, verify telemetry strip and raw send line
    fireEvent.click(screen.getByRole('tab', { name: 'Network Console' }));
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));

    act(() => {
      fake.emit.controlMessage({
        t: 'telemetry',
        ms: 1500,
        mode: 'auto',
        estop: false,
        throttle: 0.45,
        steer: -0.15,
        tof_mm: [810, 1200, 640],
        batt_mv: 7820,
        yaw_dps: 14.2,
      });
    });

    expect(screen.getByTestId('telemetry-mode').textContent).toContain('auto');
    expect(screen.getByTestId('telemetry-throttle').textContent).toContain('0.45');
    expect(screen.getByTestId('telemetry-steer').textContent).toContain('-0.15');
    expect(screen.getByTestId('telemetry-tof').textContent).toContain('810 / 1200 / 640 mm');
    expect(screen.getByTestId('telemetry-battery').textContent).toContain('7820 mV (7.82 V)');
    expect(screen.getByTestId('network-console-log').textContent).toContain('"t": "telemetry"');

    // Send raw line from Network Console
    fireEvent.change(screen.getByLabelText('Network Console send line'), {
      target: { value: '{"t":"estop"}' },
    });
    fireEvent.submit(screen.getByLabelText('Network Console send line').closest('form')!);
    await waitFor(() => {
      expect(
        fake.calls.some(
          (c) => c.service === 'control' && c.method === 'sendRaw' && c.args[0] === '{"t":"estop"}',
        ),
      ).toBe(true);
    });
  });
});
