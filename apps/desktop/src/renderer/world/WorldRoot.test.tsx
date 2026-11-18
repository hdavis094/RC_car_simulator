/// <reference types="node" />
// @vitest-environment jsdom
/* eslint-disable no-restricted-imports */
import ReactThreeTestRenderer from '@react-three/test-renderer';
import {
  SCHEMA_VERSION,
  Track,
  defaultCatalog,
  exampleCar,
  type World as WorldFile,
} from '@rcsim/schema';
import { OBSTACLE_SIZES, createRun, createScriptedSource, trackLibrary } from '@rcsim/sim-core';
import { WHEEL_ORDER, type Quat, type StateSnapshot } from '@rcsim/sim-core/api';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as THREE from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeRcsimApi } from '../../shared/fake-api.ts';
import { ipcErrorMessage } from '../../shared/ipc.ts';
import { useEnvironmentStore } from '../shell/environment-store.ts';
import { useSessionStore } from '../shell/session.ts';
import {
  BUILTIN_OVAL_TRACK,
  BUILTIN_TECHNICAL_TRACK,
  DEFAULT_ORBIT_CAMERA,
  OBSTACLE_DIMENSIONS,
  SnapshotInterpolator,
  WorldR3FScene,
  WorldRoot,
  buildWorldSceneData,
  computeCameraTransform,
  computeDriveFromGamepad,
  computeDriveFromKeys,
  createWorldDockTabs,
  defaultSnapshotForWorld,
  generateTrackMeshData,
  generateUniqueObstacleId,
  groundPointToViewportUV,
  interpolateSnapshots,
  normalizeLayoutPath,
  screenToGroundPoint,
  yawDegToQuat,
} from './index.ts';

beforeEach(() => {
  useSessionStore.setState(useSessionStore.getInitialState());
  useEnvironmentStore.setState({ current: 'workbench' });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function createFakeWithRealTracks() {
  return createFakeRcsimApi({
    tracks: {
      oval: trackLibrary.load('oval'),
      technical: trackLibrary.load('technical'),
    },
  });
}

function getThreeGroupFromR3F(
  renderer: Awaited<ReturnType<typeof ReactThreeTestRenderer.create>>,
  name: string,
): THREE.Group {
  const match = renderer.scene.find((node) => node.props['name'] === name);
  if (!match) {
    throw new Error(`Could not find R3F node with name="${name}"`);
  }
  return match.instance as THREE.Group;
}

/** Asserts two unit quaternions represent the same SO(3) rotation (`q === ±expected`). */
function expectQuaternionCloseTo(actual: THREE.Quaternion, expected: Quat, precision = 5): void {
  const dot =
    actual.x * expected[0] +
    actual.y * expected[1] +
    actual.z * expected[2] +
    actual.w * expected[3];
  const sign = dot < 0 ? -1 : 1;
  expect(actual.x).toBeCloseTo(expected[0] * sign, precision);
  expect(actual.y).toBeCloseTo(expected[1] * sign, precision);
  expect(actual.z).toBeCloseTo(expected[2] * sign, precision);
  expect(actual.w).toBeCloseTo(expected[3] * sign, precision);
}

describe('3D World environment (P1-F)', () => {
  it('renders WorldR3FScene with @react-three/test-renderer and poses the car body and all four wheels to match StateSnapshots from a real sim-core Run including after useFrame advances', async () => {
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
      const interpolator = new SnapshotInterpolator();
      const snap0 = run.snapshot();
      const baseSceneData = buildWorldSceneData(snap0, ovalTrack, null);

      let nowMs = 1000;
      vi.spyOn(performance, 'now').mockImplementation(() => nowMs);
      interpolator.push(snap0, nowMs);

      const renderer = await ReactThreeTestRenderer.create(
        <WorldR3FScene
          sceneData={baseSceneData}
          cameraMode="orbit"
          orbitState={DEFAULT_ORBIT_CAMERA}
          interpolator={interpolator}
        />,
      );

      const assertR3FMeshesMatchSnapshot = (snap: StateSnapshot) => {
        const carGroup = getThreeGroupFromR3F(renderer, 'car-body');
        carGroup.updateMatrixWorld(true);
        const worldPos = new THREE.Vector3();
        const worldQuat = new THREE.Quaternion();
        carGroup.getWorldPosition(worldPos);
        carGroup.getWorldQuaternion(worldQuat);

        expect(worldPos.x).toBeCloseTo(snap.car.pose.position[0], 5);
        expect(worldPos.y).toBeCloseTo(snap.car.pose.position[1], 5);
        expect(worldPos.z).toBeCloseTo(snap.car.pose.position[2], 5);
        expectQuaternionCloseTo(worldQuat, snap.car.pose.rotation, 5);

        WHEEL_ORDER.forEach((wheelName, index) => {
          const expectedWheel = snap.car.wheels[index]!;
          const wheelGroup = getThreeGroupFromR3F(renderer, `wheel:${wheelName}`);
          wheelGroup.updateMatrixWorld(true);
          const wPos = new THREE.Vector3();
          const wQuat = new THREE.Quaternion();
          wheelGroup.getWorldPosition(wPos);
          wheelGroup.getWorldQuaternion(wQuat);

          expect(wPos.x).toBeCloseTo(expectedWheel.position[0], 5);
          expect(wPos.y).toBeCloseTo(expectedWheel.position[1], 5);
          expect(wPos.z).toBeCloseTo(expectedWheel.position[2], 5);
          expectQuaternionCloseTo(wQuat, expectedWheel.rotation, 5);
        });
      };

      assertR3FMeshesMatchSnapshot(snap0);

      // Step 2: advance 4000 ticks (4.0 s) so the car arms, accelerates, and steers along the oval
      await run.step(4000);
      const snap1 = { ...run.snapshot(), status: 'running' as const };
      expect(snap1.car.pose.position[2]).toBeLessThan(snap0.car.pose.position[2] - 0.5);
      expect(Math.abs(snap1.car.pose.rotation[1])).toBeGreaterThan(0.02);

      nowMs = 1020;
      interpolator.push(snap1, nowMs);
      nowMs = 1040; // alpha = 1.0 -> exact snap1
      await renderer.advanceFrames(1, 0.016);
      assertR3FMeshesMatchSnapshot(snap1);

      // Step 3: advance another 600 ticks (to 4.6 s) and test mid-frame interpolation (alpha = 0.5)
      await run.step(600);
      const snap2 = { ...run.snapshot(), status: 'running' as const };
      nowMs = 1040;
      interpolator.push(snap2, nowMs);

      // Advance useFrame at midpoint nowMs = 1050 (interval = 20 ms -> alpha = 0.5)
      nowMs = 1050;
      await renderer.advanceFrames(1, 0.01);
      const expectedMid = interpolateSnapshots(snap1, snap2, 0.5);
      assertR3FMeshesMatchSnapshot(expectedMid);

      // Advance useFrame to completion nowMs = 1060 (alpha = 1.0 -> exact snap2)
      nowMs = 1060;
      await renderer.advanceFrames(1, 0.01);
      assertR3FMeshesMatchSnapshot(snap2);

      await renderer.unmount();
    } finally {
      await run.stop();
    }
  });

  it('does not grow Three.js geometry count or recreate the track mesh when rendering N snapshots with sensor beams', async () => {
    const ovalTrack = trackLibrary.load('oval');
    const world: WorldFile = {
      schemaVersion: SCHEMA_VERSION,
      name: 'No Leak Test',
      trackId: 'oval',
      seed: 1,
      obstacles: [{ id: 'cone-1', type: 'cone', positionM: { x: 2.4, z: -2.0 }, yawDeg: 0 }],
    };
    const initialSnap: StateSnapshot = {
      ...defaultSnapshotForWorld(world, ovalTrack),
      status: 'running',
      sensors: [
        {
          instanceId: 'tof_front',
          beams: [
            {
              origin: [2.4, 0.1, 0.5],
              direction: [0, 0, -1],
              maxRangeM: 1.5,
              hitM: 0.8,
            },
            {
              origin: [2.4, 0.1, 0.5],
              direction: [-0.2, 0, -0.98],
              maxRangeM: 1.5,
              hitM: null,
            },
          ],
        },
      ],
    };

    const interpolator = new SnapshotInterpolator();
    let nowMs = 1000;
    vi.spyOn(performance, 'now').mockImplementation(() => nowMs);
    interpolator.push(initialSnap, nowMs);

    const sceneData = buildWorldSceneData(initialSnap, ovalTrack, null);
    // Verify generateTrackMeshData returns the exact memoized reference for the same track
    expect(generateTrackMeshData(ovalTrack)).toBe(sceneData.trackMesh);

    const renderer = await ReactThreeTestRenderer.create(
      <WorldR3FScene
        sceneData={sceneData}
        cameraMode="follow"
        orbitState={DEFAULT_ORBIT_CAMERA}
        interpolator={interpolator}
      />,
    );

    const trackSurfaceNode = renderer.scene.find((n) => n.props['name'] === 'track-surface')!;
    const initialTrackMeshInstance = trackSurfaceNode.instance as THREE.Mesh;
    const initialTrackGeometry = initialTrackMeshInstance.geometry;

    const collectDistinctGeometries = (root: THREE.Object3D): Set<THREE.BufferGeometry> => {
      const geoms = new Set<THREE.BufferGeometry>();
      root.traverse((obj) => {
        const maybeGeom = (obj as THREE.Mesh | THREE.Line).geometry;
        if (maybeGeom instanceof THREE.BufferGeometry) {
          geoms.add(maybeGeom);
        }
      });
      return geoms;
    };

    const r3fRoot = getThreeGroupFromR3F(renderer, 'world-r3f-root');
    const baselineGeometries = collectDistinctGeometries(r3fRoot);
    const baselineCount = baselineGeometries.size;
    expect(baselineCount).toBeGreaterThan(0);

    // Feed 60 snapshots with moving car, moving obstacle, and changing beam hit distances
    for (let i = 1; i <= 60; i++) {
      nowMs += 16;
      const z = 0.75 - i * 0.05;
      const nextSnap: StateSnapshot = {
        ...initialSnap,
        tick: i * 16,
        timeUs: i * 16_000,
        car: {
          ...initialSnap.car,
          pose: { position: [2.4, 0, z], rotation: [0, 0, 0, 1] },
        },
        sensors: [
          {
            instanceId: 'tof_front',
            beams: [
              {
                origin: [2.4, 0.1, z - 0.25],
                direction: [0, 0, -1],
                maxRangeM: 1.5,
                hitM: i % 2 === 0 ? 0.5 + (i % 5) * 0.1 : null,
              },
              {
                origin: [2.4, 0.1, z - 0.25],
                direction: [-0.2, 0, -0.98],
                maxRangeM: 1.5,
                hitM: 0.9,
              },
            ],
          },
        ],
      };
      interpolator.push(nextSnap, nowMs);
      await renderer.advanceFrames(1, 0.016);
    }

    const afterGeometries = collectDistinctGeometries(r3fRoot);
    expect(afterGeometries.size).toBe(baselineCount);
    for (const geom of afterGeometries) {
      expect(baselineGeometries.has(geom)).toBe(true);
    }

    const currentTrackSurfaceNode = renderer.scene.find(
      (n) => n.props['name'] === 'track-surface',
    )!;
    expect(currentTrackSurfaceNode.instance).toBe(initialTrackMeshInstance);
    expect((currentTrackSurfaceNode.instance as THREE.Mesh).geometry).toBe(initialTrackGeometry);

    await renderer.unmount();
  });

  it('interpolates sensor beams and obstacles with the same alpha as the car so beams never lead the car', () => {
    const base = defaultSnapshotForWorld(
      {
        schemaVersion: SCHEMA_VERSION,
        name: 'Beam Interp',
        trackId: 'oval',
        seed: 1,
        obstacles: [{ id: 'cone-1', type: 'cone', positionM: { x: 1, z: -2 }, yawDeg: 0 }],
      },
      BUILTIN_OVAL_TRACK,
    );

    const prev: StateSnapshot = {
      ...base,
      tick: 100,
      timeUs: 100_000,
      status: 'running',
      car: {
        ...base.car,
        pose: { position: [2.4, 0, 0], rotation: [0, 0, 0, 1] },
      },
      sensors: [
        {
          instanceId: 'tof_front',
          beams: [
            {
              origin: [2.4, 0.1, -0.28],
              direction: [0, 0, -1],
              maxRangeM: 2.0,
              hitM: 1.0,
            },
          ],
        },
      ],
      obstacles: [
        {
          id: 'cone-1',
          type: 'cone',
          pose: { position: [1.0, 0, -2.0], rotation: yawDegToQuat(0) },
        },
      ],
    };

    const curr: StateSnapshot = {
      ...prev,
      tick: 120,
      timeUs: 120_000,
      car: {
        ...prev.car,
        pose: { position: [2.4, 0, -1.0], rotation: [0, 0, 0, 1] },
      },
      sensors: [
        {
          instanceId: 'tof_front',
          beams: [
            {
              origin: [2.4, 0.1, -1.28],
              direction: [0, 0, -1],
              maxRangeM: 2.0,
              hitM: 0.4,
            },
          ],
        },
      ],
      obstacles: [
        {
          id: 'cone-1',
          type: 'cone',
          pose: { position: [2.0, 0, -4.0], rotation: yawDegToQuat(90) },
        },
      ],
    };

    const mid = interpolateSnapshots(prev, curr, 0.25);
    expect(mid.car.pose.position[2]).toBeCloseTo(-0.25, 6);
    const midBeam = mid.sensors[0]!.beams[0]!;
    expect(midBeam.origin[2]).toBeCloseTo(-0.53, 6);
    expect(midBeam.hitM).toBeCloseTo(0.85, 6);
    expect(mid.obstacles[0]!.pose.position[0]).toBeCloseTo(1.25, 6);
    expect(mid.obstacles[0]!.pose.position[2]).toBeCloseTo(-2.5, 6);
  });

  it('places a cone on the ground, rotates it, and includes it in the next world-edit save payload with the right position and yaw', async () => {
    const fake = createFakeWithRealTracks();
    const ovalTrack = trackLibrary.load('oval');
    render(<WorldRoot api={fake.api} />);

    fireEvent.click(screen.getByRole('button', { name: 'Top-down' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cone' }));

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

    fireEvent.change(screen.getByLabelText('Placement yaw (deg)'), {
      target: { value: '20' },
    });
    const ground = screen.getByTestId('world-ground');
    fireEvent.pointerDown(ground, { button: 0, clientX: 480, clientY: 240 });
    fireEvent.pointerUp(ground);

    fireEvent.keyDown(window, { key: '[' });

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
      id: 'cone-1',
      type: 'cone',
      positionM: {
        x: expectedClickPoint.x,
        z: expectedClickPoint.z,
      },
      yawDeg: 35,
    });

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
      const interpolator = new SnapshotInterpolator();
      interpolator.push(snap, 1000);
      const sceneData = buildWorldSceneData(snap, ovalTrack, null);
      const renderer = await ReactThreeTestRenderer.create(
        <WorldR3FScene
          sceneData={sceneData}
          cameraMode="top-down"
          orbitState={DEFAULT_ORBIT_CAMERA}
          interpolator={interpolator}
        />,
      );
      const coneGroup = getThreeGroupFromR3F(renderer, 'obstacle:cone-1');
      expect(coneGroup.position.x).toBeCloseTo(expectedClickPoint.x, 5);
      expect(coneGroup.position.z).toBeCloseTo(expectedClickPoint.z, 5);
      const expectedQuat = yawDegToQuat(35);
      expect(coneGroup.quaternion.y).toBeCloseTo(expectedQuat[1], 5);
      expect(coneGroup.quaternion.w).toBeCloseTo(expectedQuat[3], 5);
      await renderer.unmount();
    } finally {
      await run.stop();
    }
  });

  it('generates non-colliding obstacle IDs when loading a layout containing cone-1 and placing a new cone', async () => {
    const fake = createFakeWithRealTracks();
    const loadedLayout: WorldFile = {
      schemaVersion: SCHEMA_VERSION,
      name: 'Existing Cone Layout',
      trackId: 'oval',
      seed: 1,
      obstacles: [{ id: 'cone-1', type: 'cone', positionM: { x: 2.4, z: -1.0 }, yawDeg: 10 }],
    };
    fake.api.worldEdit.load = vi.fn().mockResolvedValue(loadedLayout);

    render(<WorldRoot api={fake.api} />);

    fireEvent.click(screen.getByTestId('world-load-btn'));
    await waitFor(() => {
      expect(screen.getByTestId('obstacle-marker-cone-1')).toBeDefined();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Cone' }));
    const ground = screen.getByTestId('world-ground');
    fireEvent.pointerDown(ground, { button: 0, clientX: 400, clientY: 300 });
    fireEvent.pointerUp(ground);

    expect(screen.getByTestId('obstacle-marker-cone-1')).toBeDefined();
    expect(screen.getByTestId('obstacle-marker-cone-2')).toBeDefined();

    fireEvent.click(screen.getByTestId('world-save-btn'));
    await waitFor(() => {
      expect(fake.calls.some((c) => c.service === 'worldEdit' && c.method === 'save')).toBe(true);
    });
    const saveCall = fake.calls.find((c) => c.service === 'worldEdit' && c.method === 'save')!;
    const savedWorld = saveCall.args[1] as WorldFile;
    expect(savedWorld.obstacles.map((o) => o.id)).toEqual(['cone-1', 'cone-2']);

    expect(
      generateUniqueObstacleId('cone', [
        { id: 'cone-1', type: 'cone', positionM: { x: 0, z: 0 }, yawDeg: 0 },
        { id: 'cone-4', type: 'cone', positionM: { x: 1, z: 0 }, yawDeg: 0 },
      ]),
    ).toBe('cone-5');
  });

  it('aligns the pointer overlay and ground raycast at 16:9 aspect ratio (1600×900)', () => {
    const ovalTrack = trackLibrary.load('oval');
    const trackMesh = generateTrackMeshData(ovalTrack);
    const initialWorld: WorldFile = {
      schemaVersion: SCHEMA_VERSION,
      name: '16:9 Overlay Test',
      trackId: 'oval',
      seed: 1,
      obstacles: [{ id: 'cone-1', type: 'cone', positionM: { x: 2.4, z: -2.0 }, yawDeg: 15 }],
    };

    const rect16x9 = {
      left: 0,
      top: 0,
      width: 1600,
      height: 900,
      right: 1600,
      bottom: 900,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    };

    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => rect16x9);

    const fake = createFakeWithRealTracks();
    render(<WorldRoot api={fake.api} initialWorld={initialWorld} />);

    const camTransform = computeCameraTransform(
      'orbit',
      { position: [2.4, 0, 0.75], rotation: [0, 0, 0, 1] },
      trackMesh,
      DEFAULT_ORBIT_CAMERA,
    );
    const expectedUV = groundPointToViewportUV({ x: 2.4, z: -2.0 }, 1600 / 900, camTransform);

    const marker = screen.getByTestId('obstacle-marker-cone-1');
    expect(marker.style.left).toBe(`${Math.min(96, Math.max(4, expectedUV.u * 100))}%`);
    expect(marker.style.top).toBe(`${Math.min(96, Math.max(4, expectedUV.v * 100))}%`);

    const pixelX = expectedUV.u * 1600;
    const pixelY = expectedUV.v * 900;
    const unprojected = screenToGroundPoint(pixelX, pixelY, rect16x9, camTransform)!;
    expect(unprojected.x).toBeCloseTo(2.4, 2);
    expect(unprojected.z).toBeCloseTo(-2.0, 2);
  });

  it('preserves yaw during paused obstacle move and position during paused rotate, throttles paused drags to 1 IPC call per rAF, flushes on pointer-up, and uses setPointerCapture', async () => {
    const fake = createFakeWithRealTracks();
    const initialWorld: WorldFile = {
      schemaVersion: SCHEMA_VERSION,
      name: 'Paused Move Test',
      trackId: 'oval',
      seed: 1,
      obstacles: [{ id: 'cone-1', type: 'cone', positionM: { x: 2.4, z: -1.5 }, yawDeg: 42 }],
    };

    let rafCallbacks: FrameRequestCallback[] = [];
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      rafCallbacks.push(cb);
      return rafCallbacks.length;
    });
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {
      rafCallbacks = [];
    });

    render(<WorldRoot api={fake.api} initialWorld={initialWorld} />);

    // Start run and pause it so isPaused === true
    fireEvent.click(screen.getByTestId('run-play-pause-btn'));
    await waitFor(() => {
      expect(screen.getByTestId('run-play-pause-btn').textContent).toBe('Pause');
    });
    fireEvent.click(screen.getByTestId('run-play-pause-btn'));
    await waitFor(() => {
      expect(screen.getByTestId('run-play-pause-btn').textContent).toBe('Resume');
    });

    fireEvent.click(screen.getByRole('button', { name: 'Top-down' }));
    const ground = screen.getByTestId('world-ground');
    const setCaptureSpy = vi.fn();
    const releaseCaptureSpy = vi.fn();
    ground.setPointerCapture = setCaptureSpy;
    ground.hasPointerCapture = () => true;
    ground.releasePointerCapture = releaseCaptureSpy;

    const marker = screen.getByTestId('obstacle-marker-cone-1');
    fireEvent.pointerDown(marker, { button: 0, pointerId: 7, clientX: 400, clientY: 300 });
    expect(setCaptureSpy).toHaveBeenCalledWith(7);

    // Fire 3 rapid pointerMove events within a single animation frame
    fireEvent.pointerMove(ground, { pointerId: 7, clientX: 410, clientY: 290 });
    fireEvent.pointerMove(ground, { pointerId: 7, clientX: 420, clientY: 280 });
    fireEvent.pointerMove(ground, { pointerId: 7, clientX: 430, clientY: 270 });

    // Before rAF fires, no moveObstacle IPC call has been sent yet
    expect(
      fake.calls.filter((c) => c.service === 'worldEdit' && c.method === 'moveObstacle'),
    ).toHaveLength(0);

    // Flush the animation frame -> exactly 1 moveObstacle IPC call with preserved yawDeg = 42
    act(() => {
      const cbs = [...rafCallbacks];
      rafCallbacks = [];
      cbs.forEach((cb) => cb(16));
    });

    const moveCallsAfterRaf = fake.calls.filter(
      (c) => c.service === 'worldEdit' && c.method === 'moveObstacle',
    );
    expect(moveCallsAfterRaf).toHaveLength(1);
    expect(moveCallsAfterRaf[0]!.args[0]).toBe('cone-1');
    expect(moveCallsAfterRaf[0]!.args[2]).toBe(42);

    // Move again and release pointer before rAF -> pointer-up flushes final pose and releases capture
    fireEvent.pointerMove(ground, { pointerId: 7, clientX: 450, clientY: 250 });
    fireEvent.pointerUp(ground, { pointerId: 7, clientX: 450, clientY: 250 });
    expect(releaseCaptureSpy).toHaveBeenCalledWith(7);

    const moveCallsAfterUp = fake.calls.filter(
      (c) => c.service === 'worldEdit' && c.method === 'moveObstacle',
    );
    expect(moveCallsAfterUp).toHaveLength(2);
    const finalMovedPos = moveCallsAfterUp[1]!.args[1] as { x: number; z: number };
    expect(moveCallsAfterUp[1]!.args[2]).toBe(42);

    // Now rotate via the "+15°" button while paused -> positionM must be preserved as finalMovedPos!
    fireEvent.click(screen.getByRole('button', { name: 'Rotate left 15°' }));
    const moveCallsAfterRotate = fake.calls.filter(
      (c) => c.service === 'worldEdit' && c.method === 'moveObstacle',
    );
    expect(moveCallsAfterRotate).toHaveLength(3);
    expect(moveCallsAfterRotate[2]!.args[0]).toBe('cone-1');
    expect(moveCallsAfterRotate[2]!.args[1]).toEqual(finalMovedPos);
    expect(moveCallsAfterRotate[2]!.args[2]).toBe(57);
  });

  it('rolls back local obstacle state when paused add, move, or delete IPC calls reject with a non-stub error', async () => {
    const fake = createFakeWithRealTracks();
    const initialWorld: WorldFile = {
      schemaVersion: SCHEMA_VERSION,
      name: 'Rollback Test',
      trackId: 'oval',
      seed: 1,
      obstacles: [{ id: 'cone-1', type: 'cone', positionM: { x: 2.4, z: -1.5 }, yawDeg: 10 }],
    };

    render(<WorldRoot api={fake.api} initialWorld={initialWorld} />);

    // Start run and pause it
    fireEvent.click(screen.getByTestId('run-play-pause-btn'));
    await waitFor(() => {
      expect(screen.getByTestId('run-play-pause-btn').textContent).toBe('Pause');
    });
    fireEvent.click(screen.getByTestId('run-play-pause-btn'));
    await waitFor(() => {
      expect(screen.getByTestId('run-play-pause-btn').textContent).toBe('Resume');
    });

    // 1. Paused addObstacle rejects -> cone-2 is rolled back
    fake.api.worldEdit.addObstacle = vi
      .fn()
      .mockRejectedValue(new Error(ipcErrorMessage('invalid', 'Obstacle out of bounds')));

    fireEvent.click(screen.getByRole('button', { name: 'Cone' }));
    const ground = screen.getByTestId('world-ground');
    fireEvent.pointerDown(ground, { button: 0, clientX: 400, clientY: 300 });
    fireEvent.pointerUp(ground);

    await waitFor(() => {
      expect(screen.queryByTestId('obstacle-marker-cone-2')).toBeNull();
      expect(screen.getByRole('alert').textContent).toContain('Obstacle out of bounds');
    });

    // 2. Paused moveObstacle rejects -> cone-1 rolls back to x=2.4, z=-1.5, yaw=10
    fake.api.worldEdit.moveObstacle = vi
      .fn()
      .mockRejectedValue(new Error(ipcErrorMessage('busy', 'Move rejected by sim')));

    fireEvent.click(screen.getByRole('button', { name: 'Select' }));
    fireEvent.pointerDown(screen.getByTestId('obstacle-marker-cone-1'), { button: 0 });
    fireEvent.pointerUp(screen.getByTestId('obstacle-marker-cone-1'));
    fireEvent.click(screen.getByRole('button', { name: 'Rotate left 15°' }));

    await waitFor(() => {
      expect(
        Number(screen.getByTestId('obstacle-marker-cone-1').getAttribute('data-yaw-deg')),
      ).toBe(10);
      expect(screen.getByRole('alert').textContent).toContain('Move rejected by sim');
    });

    // 3. Paused removeObstacle rejects -> cone-1 is restored
    fake.api.worldEdit.removeObstacle = vi
      .fn()
      .mockRejectedValue(new Error(ipcErrorMessage('busy', 'Delete rejected by sim')));

    fireEvent.click(screen.getByRole('button', { name: 'Delete obstacle' }));
    await waitFor(() => {
      expect(screen.getByTestId('obstacle-marker-cone-1')).toBeDefined();
      expect(screen.getByRole('alert').textContent).toContain('Delete rejected by sim');
    });
  });

  it('clears held keys and releases drive on window blur and document visibilitychange to hidden, and ignores repeat/Ctrl/Meta/Alt keydowns', async () => {
    vi.useFakeTimers();
    const fake = createFakeWithRealTracks();
    render(<WorldRoot api={fake.api} />);

    // Ignore keydown with ctrlKey, metaKey, altKey, or repeat
    await act(async () => {
      fireEvent.keyDown(window, { key: 's', ctrlKey: true });
      fireEvent.keyDown(window, { key: 's', metaKey: true });
      fireEvent.keyDown(window, { key: 'w', altKey: true });
      fireEvent.keyDown(window, { key: 'w', repeat: true });
      vi.advanceTimersByTime(40);
      await Promise.resolve();
    });
    expect(fake.calls.filter((c) => c.service === 'control' && c.method === 'drive')).toHaveLength(
      0,
    );

    // Hold W -> starts driving forward
    await act(async () => {
      fireEvent.keyDown(window, { key: 'w' });
      await Promise.resolve();
    });
    await act(async () => {
      vi.advanceTimersByTime(40);
      await Promise.resolve();
    });
    const driveCallsBeforeBlur = fake.calls.filter(
      (c) => c.service === 'control' && c.method === 'drive',
    );
    expect(driveCallsBeforeBlur.length).toBeGreaterThanOrEqual(2);
    expect(driveCallsBeforeBlur.at(-1)?.args[0]).toEqual({ throttle: 1, steer: 0 });

    // Window loses focus (blur) while W is still held -> sends neutral drive(0, 0), calls releaseDrive, and stops sending
    await act(async () => {
      fireEvent.blur(window);
      await Promise.resolve();
    });
    await act(async () => {
      await Promise.resolve();
    });

    const driveCallsOnBlur = fake.calls.filter(
      (c) => c.service === 'control' && c.method === 'drive',
    );
    expect(driveCallsOnBlur.at(-1)?.args[0]).toEqual({ throttle: 0, steer: 0 });
    expect(fake.calls.some((c) => c.service === 'control' && c.method === 'releaseDrive')).toBe(
      true,
    );

    const countAfterBlur = fake.calls.filter(
      (c) => c.service === 'control' && c.method === 'drive',
    ).length;
    await act(async () => {
      vi.advanceTimersByTime(100);
      await Promise.resolve();
    });
    expect(fake.calls.filter((c) => c.service === 'control' && c.method === 'drive')).toHaveLength(
      countAfterBlur,
    );

    // Hold D, then trigger visibilitychange to hidden -> sends neutral and releases drive
    await act(async () => {
      fireEvent.keyDown(window, { key: 'd' });
      vi.advanceTimersByTime(25);
      await Promise.resolve();
    });
    expect(
      fake.calls.filter((c) => c.service === 'control' && c.method === 'drive').at(-1)?.args[0],
    ).toEqual({ throttle: 0, steer: 1 });

    const releaseCountBeforeHide = fake.calls.filter(
      (c) => c.service === 'control' && c.method === 'releaseDrive',
    ).length;
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'hidden',
    });
    await act(async () => {
      fireEvent(document, new Event('visibilitychange'));
      await Promise.resolve();
    });
    await act(async () => {
      await Promise.resolve();
    });
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'visible',
    });

    expect(
      fake.calls.filter((c) => c.service === 'control' && c.method === 'drive').at(-1)?.args[0],
    ).toEqual({ throttle: 0, steer: 0 });
    expect(
      fake.calls.filter((c) => c.service === 'control' && c.method === 'releaseDrive').length,
    ).toBeGreaterThan(releaseCountBeforeHide);
  });

  it('releases drive on leaving manual mode, on switching away from the 3D World environment, and on unmount (and disconnects control on unmount)', async () => {
    vi.useFakeTimers();
    const fake = createFakeWithRealTracks();
    useEnvironmentStore.setState({ current: 'world' });
    const { unmount } = render(<WorldRoot api={fake.api} />);

    // 1. Hold W in manual mode, then switch to Auto mode -> releases drive
    await act(async () => {
      fireEvent.keyDown(window, { key: 'w' });
      await Promise.resolve();
    });
    await act(async () => {
      vi.advanceTimersByTime(25);
      await Promise.resolve();
    });
    expect(
      fake.calls.filter((c) => c.service === 'control' && c.method === 'drive').at(-1)?.args[0],
    ).toEqual({ throttle: 1, steer: 0 });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Auto mode' }));
      await Promise.resolve();
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(
      fake.calls.filter((c) => c.service === 'control' && c.method === 'drive').at(-1)?.args[0],
    ).toEqual({ throttle: 0, steer: 0 });
    const releasesAfterModeSwitch = fake.calls.filter(
      (c) => c.service === 'control' && c.method === 'releaseDrive',
    ).length;
    expect(releasesAfterModeSwitch).toBeGreaterThanOrEqual(1);

    // 2. Switch back to Manual mode, hold W, then switch environment away from 'world' to 'terminal' -> releases drive
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Manual mode' }));
      await Promise.resolve();
    });
    await act(async () => {
      fireEvent.keyDown(window, { key: 'w' });
      vi.advanceTimersByTime(25);
      await Promise.resolve();
    });
    expect(
      fake.calls.filter((c) => c.service === 'control' && c.method === 'drive').at(-1)?.args[0],
    ).toEqual({ throttle: 1, steer: 0 });

    await act(async () => {
      useEnvironmentStore.getState().show('terminal');
      await Promise.resolve();
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(
      fake.calls.filter((c) => c.service === 'control' && c.method === 'drive').at(-1)?.args[0],
    ).toEqual({ throttle: 0, steer: 0 });
    const releasesAfterEnvSwitch = fake.calls.filter(
      (c) => c.service === 'control' && c.method === 'releaseDrive',
    ).length;
    expect(releasesAfterEnvSwitch).toBeGreaterThan(releasesAfterModeSwitch);

    // 3. Switch back to 'world', hold W, and unmount WorldRoot -> releases drive and calls control.disconnect()
    await act(async () => {
      useEnvironmentStore.getState().show('world');
      await Promise.resolve();
    });
    await act(async () => {
      fireEvent.keyDown(window, { key: 'w' });
      vi.advanceTimersByTime(25);
      await Promise.resolve();
    });

    await act(async () => {
      unmount();
      await Promise.resolve();
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(
      fake.calls.filter((c) => c.service === 'control' && c.method === 'releaseDrive').length,
    ).toBeGreaterThan(releasesAfterEnvSwitch);
    expect(fake.calls.some((c) => c.service === 'control' && c.method === 'disconnect')).toBe(true);
  });

  it('produces drive commands with expected throttle and steer signs on WASD/arrow keys at 50 Hz while manual, and sends mode and estop commands through control IPC', async () => {
    vi.useFakeTimers();
    const fake = createFakeWithRealTracks();
    render(<WorldRoot api={fake.api} />);

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

    const padCommand = computeDriveFromGamepad(() => [
      {
        connected: true,
        axes: [-0.5, -0.8],
        buttons: [],
      } as unknown as Gamepad,
    ]);
    expect(padCommand).toEqual({ throttle: 0.8, steer: -0.5 });

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

    await act(async () => {
      fireEvent.keyDown(window, { key: 'a' });
      await Promise.resolve();
    });
    const forwardLeft = fake.calls
      .filter((c) => c.service === 'control' && c.method === 'drive')
      .map((c) => c.args[0] as { throttle: number; steer: number })
      .at(-1);
    expect(forwardLeft).toEqual({ throttle: 1, steer: -1 });

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

    await act(async () => {
      fireEvent.keyDown(window, { key: ' ', code: 'Space' });
      await Promise.resolve();
    });
    expect(fake.calls.some((c) => c.service === 'control' && c.method === 'estop')).toBe(true);
  });

  it('backs off control.connect retries when no run exists instead of calling connect on every 50 Hz drive tick, and connects immediately when a run starts', async () => {
    vi.useFakeTimers();
    let nowMs = 1000;
    vi.spyOn(performance, 'now').mockImplementation(() => nowMs);

    const fake = createFakeWithRealTracks();
    const connectSpy = vi
      .fn()
      .mockRejectedValue(
        new Error(ipcErrorMessage('not-implemented', 'control.connect not implemented')),
      );
    fake.api.control.connect = connectSpy;

    render(<WorldRoot api={fake.api} />);

    // Hold W for 200 ms (10 ticks at 50 Hz) while no run exists and connect fails
    await act(async () => {
      fireEvent.keyDown(window, { key: 'w' });
      await Promise.resolve();
    });
    for (let i = 0; i < 10; i++) {
      nowMs += 20;
      await act(async () => {
        vi.advanceTimersByTime(20);
        await Promise.resolve();
      });
    }

    // Backoff prevents spamming control.connect on every 20 ms tick (called only once)
    expect(connectSpy).toHaveBeenCalledTimes(1);

    // When a run starts, control.connect is attempted immediately
    connectSpy.mockResolvedValueOnce(undefined);
    await act(async () => {
      fireEvent.click(screen.getByTestId('run-play-pause-btn'));
      await Promise.resolve();
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(connectSpy).toHaveBeenCalledTimes(2);
  });

  it('keeps renderer track fallbacks and OBSTACLE_DIMENSIONS identical to sim-core assets and OBSTACLE_SIZES', () => {
    const ovalPath = resolve(__dirname, '../../../../../packages/sim-core/assets/tracks/oval.json');
    const technicalPath = resolve(
      __dirname,
      '../../../../../packages/sim-core/assets/tracks/technical.json',
    );
    const simCoreOval = Track.parse(JSON.parse(readFileSync(ovalPath, 'utf8')));
    const simCoreTechnical = Track.parse(JSON.parse(readFileSync(technicalPath, 'utf8')));

    expect(BUILTIN_OVAL_TRACK).toEqual(simCoreOval);
    expect(BUILTIN_TECHNICAL_TRACK).toEqual(simCoreTechnical);
    expect(OBSTACLE_DIMENSIONS).toEqual(OBSTACLE_SIZES);
  });

  it('rejects path traversal and paths outside worlds/ in normalizeLayoutPath and validates with World.parse before save fallback writes', async () => {
    expect(normalizeLayoutPath('oval-cones')).toBe('worlds/oval-cones.json');
    expect(normalizeLayoutPath('worlds/custom.json')).toBe('worlds/custom.json');
    expect(() => normalizeLayoutPath('../outside.json')).toThrow(/Invalid layout path/);
    expect(() => normalizeLayoutPath('worlds/../secret.json')).toThrow(/Invalid layout path/);
    expect(() => normalizeLayoutPath('/etc/passwd')).toThrow(/Invalid layout path/);
    expect(() => normalizeLayoutPath('C:\\temp\\bad.json')).toThrow(/Invalid layout path/);
    expect(() => normalizeLayoutPath('other-dir/file.json')).toThrow(/Invalid layout path/);

    const fake = createFakeWithRealTracks();
    fake.api.worldEdit.save = vi
      .fn()
      .mockRejectedValue(
        new Error(ipcErrorMessage('not-implemented', 'worldEdit.save not implemented')),
      );
    const writeFileSpy = vi.spyOn(fake.api.project, 'writeFile');

    const invalidWorld = {
      schemaVersion: SCHEMA_VERSION,
      name: '', // invalid minLength 1 in World schema
      trackId: 'oval',
      seed: 1,
      obstacles: [],
    } as WorldFile;

    const { unmount } = render(<WorldRoot api={fake.api} initialWorld={invalidWorld} />);
    fireEvent.click(screen.getByTestId('world-save-btn'));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeDefined();
    });
    expect(writeFileSpy).not.toHaveBeenCalled();
    unmount();

    render(<WorldRoot api={fake.api} />);
    fireEvent.change(screen.getByLabelText('Layout path'), {
      target: { value: '../escape.json' },
    });
    fireEvent.click(screen.getByTestId('world-save-btn'));
    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain('Invalid layout path');
    });
    expect(writeFileSpy).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText('Layout path'), {
      target: { value: 'worlds/valid-fallback.json' },
    });
    fireEvent.click(screen.getByTestId('world-save-btn'));
    await waitFor(() => {
      expect(writeFileSpy).toHaveBeenCalledWith(
        'worlds/valid-fallback.json',
        expect.stringContaining('"trackId": "oval"'),
      );
    });
  });

  it('updates sim readouts, runs/pauses/steps/stops simulation, exports createWorldDockTabs, and displays Network Console telemetry and pretty-printed messages', async () => {
    const fake = createFakeWithRealTracks();
    const tabs = createWorldDockTabs(fake.api);
    expect(tabs).toHaveLength(1);
    expect(tabs[0]?.id).toBe('network');
    expect(tabs[0]?.label).toBe('Network Console');

    render(<WorldRoot api={fake.api} />);

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

    expect(screen.getByTestId('sim-time-display').textContent).toContain('0.250 s');
    expect(screen.getByTestId('lap-counter').textContent).toContain('2');
    expect(screen.getByTestId('collision-count').textContent).toContain('1 (wall)');

    // Run controls: start run (also auto-connects control), pause, step, change speed, stop
    fireEvent.change(screen.getByLabelText('Seed'), { target: { value: '7' } });
    fireEvent.click(screen.getByTestId('run-play-pause-btn'));
    await waitFor(() => {
      expect(screen.getByTestId('run-play-pause-btn').textContent).toBe('Pause');
    });

    expect((screen.getByRole('button', { name: 'Cone' }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByTestId('run-play-pause-btn'));
    await waitFor(() => {
      expect(screen.getByTestId('run-play-pause-btn').textContent).toBe('Resume');
    });

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

    fireEvent.click(screen.getByTestId('run-stop-btn'));
    await waitFor(() => {
      expect(screen.getByTestId('run-play-pause-btn').textContent).toBe('Run');
    });

    // Bottom dock: switch to Network Console tab, verify telemetry strip and raw send line
    fireEvent.click(screen.getByRole('tab', { name: 'Network Console' }));

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
