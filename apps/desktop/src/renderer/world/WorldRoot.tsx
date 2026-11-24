import type { Mode } from '@rcsim/control-protocol/messages';
import {
  SCHEMA_VERSION,
  World,
  type Obstacle,
  type ObstacleType,
  type Track,
  type World as WorldFile,
} from '@rcsim/schema';
import type { StateSnapshot } from '@rcsim/sim-core/api';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  RUN_SPEEDS,
  parseIpcError,
  type RcsimApi,
  type RunInfo,
  type RunSpeed,
} from '../../shared/ipc.ts';
import { BottomPanel, type DockTab } from '../shell/BottomPanel.tsx';
import { useEnvironmentStore } from '../shell/environment-store.ts';
import {
  DRIVE_INTERVAL_MS,
  isEditableEventTarget,
  isEstopKey,
  isInteractiveControlTarget,
  isModifierKey,
  normalizeDriveKey,
  sampleManualDriveInput,
  type DriveCommandInput,
} from './driving-controller.ts';
import { SnapshotInterpolator } from './interpolation.ts';
import { NetworkConsole, primeControlLinkTracker } from './NetworkConsole.tsx';
import {
  CAMERA_MODES,
  DEFAULT_ORBIT_CAMERA,
  buildWorldSceneData,
  defaultSnapshotForWorld,
  type CameraMode,
  type OrbitCameraState,
} from './scene-data.ts';
import { WorldScene, type EditorTool, type SceneRunMode } from './WorldScene.tsx';

const DEFAULT_WORLD_FILE: WorldFile = {
  schemaVersion: SCHEMA_VERSION,
  name: 'Oval layout',
  trackId: 'oval',
  seed: 1,
  obstacles: [],
};

const CAMERA_LABELS: Record<CameraMode, string> = {
  follow: 'Follow',
  orbit: 'Orbit',
  'top-down': 'Top-down',
};

const PALETTE_TOOLS: readonly { readonly id: EditorTool; readonly label: string }[] = [
  { id: 'select', label: 'Select' },
  { id: 'cone', label: 'Cone' },
  { id: 'box', label: 'Box' },
  { id: 'wall', label: 'Wall section' },
  { id: 'ramp', label: 'Ramp' },
];

export const INITIAL_CONNECT_BACKOFF_MS = 100;
export const MAX_CONNECT_BACKOFF_MS = 2000;

/**
 * Validates and normalizes a relative layout file path inside `worlds/`.
 * Rejects `..`, backslashes, drive letters, absolute paths, and anything outside `worlds/`.
 */
export function normalizeLayoutPath(raw: string): string {
  const trimmed = raw.trim() || 'worlds/oval-cones.json';
  if (trimmed.includes('\\')) {
    throw new Error('Invalid layout path: backslashes are not allowed.');
  }
  if (trimmed.startsWith('/') || /^[a-zA-Z]:/.test(trimmed)) {
    throw new Error('Invalid layout path: path must be relative to worlds/.');
  }
  const segments = trimmed.split('/');
  if (segments.some((seg) => seg === '..' || seg === '.' || seg.length === 0)) {
    throw new Error('Invalid layout path: path traversal is not allowed.');
  }
  if (segments.length > 1 && segments[0] !== 'worlds') {
    throw new Error('Invalid layout path: path must be inside worlds/.');
  }
  const withPrefix = segments[0] === 'worlds' ? trimmed : `worlds/${trimmed}`;
  const normalized = withPrefix.endsWith('.json') ? withPrefix : `${withPrefix}.json`;
  const finalSegments = normalized.split('/');
  if (
    finalSegments[0] !== 'worlds' ||
    finalSegments.length < 2 ||
    finalSegments.slice(1).some((s) => s.length === 0 || s === '.json')
  ) {
    throw new Error('Invalid layout path: must specify a filename inside worlds/.');
  }
  return normalized;
}

/**
 * Generates an obstacle ID of the form `<type>-<n>` that is guaranteed unique
 * against `existingObstacles` (taking the max existing numeric suffix for `<type>` + 1).
 */
export function generateUniqueObstacleId(
  type: ObstacleType,
  existingObstacles: readonly Obstacle[],
): string {
  const usedIds = new Set(existingObstacles.map((o) => o.id).filter(Boolean));
  const prefix = `${type}-`;
  let maxSuffix = 0;
  for (const obs of existingObstacles) {
    if (!obs.id) continue;
    if (obs.id.startsWith(prefix)) {
      const rest = obs.id.slice(prefix.length);
      if (/^\d+$/.test(rest)) {
        const n = Number.parseInt(rest, 10);
        if (n > maxSuffix) maxSuffix = n;
      }
    }
  }
  let candidateNum = maxSuffix + 1;
  while (usedIds.has(`${prefix}${candidateNum}`)) {
    candidateNum++;
  }
  return `${prefix}${candidateNum}`;
}

/**
 * Ensures every obstacle in a `WorldFile` has a real, unique `id`
 * so selection, dragging, rotation, and deletion work even when a layout file
 * omitted optional obstacle `id` fields.
 */
export function ensureWorldObstacleIds(world: WorldFile): WorldFile {
  const assigned: Obstacle[] = [];
  let changed = false;
  for (const obs of world.obstacles) {
    const trimmedId = obs.id?.trim();
    const alreadyUsed = trimmedId ? assigned.some((a) => a.id === trimmedId) : false;
    if (!trimmedId || alreadyUsed) {
      const id = generateUniqueObstacleId(obs.type, assigned);
      assigned.push({ ...obs, id });
      changed = true;
    } else if (trimmedId !== obs.id) {
      assigned.push({ ...obs, id: trimmedId });
      changed = true;
    } else {
      assigned.push(obs);
    }
  }
  return changed ? { ...world, obstacles: assigned } : world;
}

export function createWorldDockTabs(api?: RcsimApi): readonly DockTab[] {
  return [
    {
      id: 'network',
      label: 'Network Console',
      content: <NetworkConsole {...(api ? { api } : {})} />,
    },
  ];
}

export interface WorldRootProps {
  readonly api?: RcsimApi;
  readonly initialWorld?: WorldFile;
  readonly prepareRun?: () => Promise<void>;
  readonly controlConnectsAutomatically?: boolean;
  /**
   * When true, mounts a standalone `BottomPanel` containing `createWorldDockTabs(api)`.
   * Defaults to `false` (in `App.tsx`, the shell mounts World's dock tabs directly in its shared `BottomPanel`).
   */
  readonly showDock?: boolean;
}

/** Root of the 3D World environment (P1-F). */
export function WorldRoot({
  api,
  initialWorld,
  prepareRun,
  controlConnectsAutomatically = false,
  showDock = false,
}: WorldRootProps = {}): ReactNode {
  const resolvedApi = api ?? window.rcsim;
  primeControlLinkTracker(resolvedApi);

  const [interpolator] = useState<SnapshotInterpolator>(() => new SnapshotInterpolator());
  const latestSnapshotRef = useRef<StateSnapshot | null>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const simTimeRef = useRef<HTMLSpanElement>(null);
  const lapCounterRef = useRef<HTMLSpanElement>(null);
  const collisionCountRef = useRef<HTMLSpanElement>(null);

  const [trackIds, setTrackIds] = useState<readonly string[]>([]);
  const [track, setTrack] = useState<Track | null>(null);
  const trackRef = useRef<Track | null>(track);
  const [worldFile, setWorldFile] = useState<WorldFile>(() =>
    ensureWorldObstacleIds(initialWorld ?? DEFAULT_WORLD_FILE),
  );
  const worldFileRef = useRef<WorldFile>(worldFile);

  const [layoutPaths, setLayoutPaths] = useState<readonly string[]>([]);
  const [layoutPath, setLayoutPath] = useState('worlds/oval-cones.json');
  const [statusMessage, setStatusMessage] = useState('');
  const [errorMessage, setErrorMessage] = useState('');

  // Run state
  const [runInfo, setRunInfo] = useState<RunInfo | null>(null);
  const runInfoRef = useRef<RunInfo | null>(null);
  const [speed, setSpeed] = useState<RunSpeed>(1);
  const [seed, setSeed] = useState<number>((initialWorld ?? DEFAULT_WORLD_FILE).seed);

  // Camera & scene editor state
  const [cameraMode, setCameraMode] = useState<CameraMode>('orbit');
  const [orbitState, setOrbitState] = useState<OrbitCameraState>(DEFAULT_ORBIT_CAMERA);
  const [activeTool, setActiveTool] = useState<EditorTool>('select');
  const [selectedObstacleId, setSelectedObstacleId] = useState<string | null>(null);
  const selectedObstacleIdRef = useRef<string | null>(selectedObstacleId);
  const [placementX, setPlacementX] = useState<number>(2.4);
  const [placementZ, setPlacementZ] = useState<number>(-1.5);
  const [placementYawDeg, setPlacementYawDeg] = useState<number>(0);
  const [placementCoordsTouched, setPlacementCoordsTouched] = useState(false);

  useEffect(() => {
    trackRef.current = track;
  }, [track]);

  useEffect(() => {
    worldFileRef.current = worldFile;
  }, [worldFile]);

  useEffect(() => {
    runInfoRef.current = runInfo;
  }, [runInfo]);

  useEffect(() => {
    selectedObstacleIdRef.current = selectedObstacleId;
  }, [selectedObstacleId]);

  // Driving state
  const [driveMode, setDriveMode] = useState<Mode>('manual');
  const driveModeRef = useRef<Mode>(driveMode);
  const [estopLatched, setEstopLatched] = useState(false);
  const [lastDriveCommand, setLastDriveCommand] = useState<DriveCommandInput>({
    throttle: 0,
    steer: 0,
  });
  const pressedKeysRef = useRef<Set<string>>(new Set());
  const driveActiveRef = useRef(false);
  const controlConnectedRef = useRef(false);
  const connectInFlightRef = useRef<Promise<boolean> | null>(null);
  const connectFailuresRef = useRef<number>(0);
  const lastConnectFailAtMsRef = useRef<number>(-Infinity);

  useEffect(() => {
    driveModeRef.current = driveMode;
  }, [driveMode]);

  // Environment tracking for releasing drive and pausing Canvas frameloop when switching away from 3D World
  const currentEnv = useEnvironmentStore((state) => state.current);
  const isWorldActive = currentEnv === 'world';

  const reportError = useCallback((err: unknown): void => {
    const parsed = parseIpcError(err);
    if (parsed.code === 'not-implemented') return;
    setErrorMessage(parsed.message);
  }, []);

  const updateReadoutsDom = useCallback((snapshot: StateSnapshot): void => {
    if (viewportRef.current) {
      const [x, , z] = snapshot.car.pose.position;
      viewportRef.current.dataset['carX'] = String(x);
      viewportRef.current.dataset['carZ'] = String(z);
    }
    const simTimeSeconds = (snapshot.timeUs / 1_000_000).toFixed(3);
    const time = simTimeRef.current?.lastChild;
    const laps = lapCounterRef.current?.lastChild;
    const collisions = collisionCountRef.current?.lastChild;
    if (time) time.textContent = ` ${simTimeSeconds} s`;
    if (laps) laps.textContent = ` ${snapshot.laps.count}`;
    if (collisions) {
      const lastSuffix = snapshot.collisions.last ? ` (${snapshot.collisions.last})` : '';
      collisions.textContent = ` ${snapshot.collisions.count}${lastSuffix}`;
    }
  }, []);

  const resetSnapshotState = useCallback(
    (nextWorld: WorldFile = worldFileRef.current, nextTrack = trackRef.current): void => {
      latestSnapshotRef.current = null;
      interpolator.reset();
      if (nextTrack) updateReadoutsDom(defaultSnapshotForWorld(nextWorld, nextTrack));
    },
    [interpolator, updateReadoutsDom],
  );

  const loadTrackById = useCallback(
    async (id: string, options?: { readonly resetInterpolator?: boolean }): Promise<Track> => {
      const loaded = await resolvedApi.worldEdit.loadTrack(id);
      trackRef.current = loaded;
      setTrack(loaded);
      if (options?.resetInterpolator) resetSnapshotState(worldFileRef.current, loaded);
      return loaded;
    },
    [resetSnapshotState, resolvedApi],
  );

  const ensureControlConnected = useCallback(
    async (options?: { readonly force?: boolean }): Promise<boolean> => {
      if (controlConnectedRef.current) return true;
      if (controlConnectsAutomatically) return false;
      if (connectInFlightRef.current) return connectInFlightRef.current;

      const now = performance.now();
      if (!options?.force && connectFailuresRef.current > 0) {
        const backoffMs = Math.min(
          MAX_CONNECT_BACKOFF_MS,
          INITIAL_CONNECT_BACKOFF_MS * 2 ** (connectFailuresRef.current - 1),
        );
        if (now - lastConnectFailAtMsRef.current < backoffMs) {
          return false;
        }
      }

      const promise = (async () => {
        try {
          await resolvedApi.control.connect({ kind: 'run' });
          controlConnectedRef.current = true;
          connectFailuresRef.current = 0;
          lastConnectFailAtMsRef.current = -Infinity;
          return true;
        } catch {
          controlConnectedRef.current = false;
          connectFailuresRef.current += 1;
          lastConnectFailAtMsRef.current = performance.now();
          return false;
        } finally {
          connectInFlightRef.current = null;
        }
      })();
      connectInFlightRef.current = promise;
      return promise;
    },
    [controlConnectsAutomatically, resolvedApi],
  );

  // Discover tracks, layouts, and initial run state
  useEffect(() => {
    let alive = true;
    void resolvedApi.worldEdit
      .listTracks()
      .then((ids) => {
        if (alive && ids.length > 0) setTrackIds(ids);
      })
      .catch(() => {});

    void resolvedApi.worldEdit
      .loadTrack(worldFileRef.current.trackId)
      .then((loaded) => {
        if (alive) {
          trackRef.current = loaded;
          setTrack(loaded);
        }
      })
      .catch((err) => {
        if (!alive) return;
        reportError(err);
      });

    void resolvedApi.worldEdit
      .listLayouts()
      .then((paths) => {
        if (alive) {
          setLayoutPaths(paths);
          if (paths[0]) setLayoutPath(paths[0]);
        }
      })
      .catch(() => {});

    void resolvedApi.run
      .info()
      .then((info) => {
        if (alive && info) {
          runInfoRef.current = info;
          setRunInfo(info);
          setSpeed(info.speed);
          setSeed(info.seed);
          if (info.state === 'running' || info.state === 'starting' || info.state === 'paused') {
            connectFailuresRef.current = 0;
            lastConnectFailAtMsRef.current = -Infinity;
            void ensureControlConnected({ force: true });
          }
        }
      })
      .catch(() => {});

    const offStatus = resolvedApi.run.onStatus((info) => {
      if (!alive) return;
      const prevState = runInfoRef.current?.state;
      runInfoRef.current = info;
      setRunInfo(info);
      setSpeed(info.speed);
      setSeed(info.seed);
      if (info.state === 'ended') {
        resetSnapshotState();
      }
      if (info.trackId) {
        if (trackRef.current?.id !== info.trackId) {
          void loadTrackById(info.trackId, { resetInterpolator: info.state === 'ended' }).catch(
            reportError,
          );
        }
      }
      if (
        (info.state === 'running' || info.state === 'starting' || info.state === 'paused') &&
        prevState !== info.state
      ) {
        connectFailuresRef.current = 0;
        lastConnectFailAtMsRef.current = -Infinity;
        void ensureControlConnected({ force: true });
      }
    });

    // Keep snapshots out of React state so snapshot arrival never re-renders WorldRoot
    const offSnapshot = resolvedApi.run.onSnapshot((snapshot) => {
      if (!alive) return;
      if (runInfoRef.current?.state === 'ended') return;
      latestSnapshotRef.current = snapshot;
      interpolator.push(snapshot, performance.now());
      updateReadoutsDom(snapshot);
    });

    const offControlState = resolvedApi.control.onState((state) => {
      controlConnectedRef.current = state === 'connected';
      if (state === 'connected') {
        connectFailuresRef.current = 0;
        lastConnectFailAtMsRef.current = -Infinity;
      }
    });

    return () => {
      alive = false;
      offStatus();
      offSnapshot();
      offControlState();
    };
  }, [
    ensureControlConnected,
    interpolator,
    loadTrackById,
    resetSnapshotState,
    resolvedApi,
    reportError,
    updateReadoutsDom,
  ]);

  const isRunning = runInfo?.state === 'running' || runInfo?.state === 'starting';
  const isPaused = runInfo?.state === 'paused';
  const editable = !isRunning;
  const sceneRunMode: SceneRunMode = isRunning ? 'running' : isPaused ? 'paused' : 'idle';

  // Build structural scene data from editor worldFile and track (does not depend on 60 Hz snapshots)
  const sceneData = useMemo(
    () =>
      track
        ? buildWorldSceneData(defaultSnapshotForWorld(worldFile, track), track, selectedObstacleId)
        : null,
    [worldFile, selectedObstacleId, track],
  );

  const sendDriveCommand = useCallback(
    (command: DriveCommandInput): void => {
      if (driveModeRef.current !== 'manual') return;
      setLastDriveCommand((prev) =>
        prev.throttle === command.throttle && prev.steer === command.steer ? prev : command,
      );
      void (async () => {
        const connected = await ensureControlConnected();
        if (!connected || driveModeRef.current !== 'manual') return;
        await resolvedApi.control.drive(command).catch(() => {});
      })();
    },
    [ensureControlConnected, resolvedApi],
  );

  const releaseActiveDrive = useCallback(
    (alwaysRelease = false): void => {
      const hadKeys = pressedKeysRef.current.size > 0;
      const wasActive = driveActiveRef.current;
      pressedKeysRef.current.clear();
      driveActiveRef.current = false;
      setLastDriveCommand((prev) =>
        prev.throttle === 0 && prev.steer === 0 ? prev : { throttle: 0, steer: 0 },
      );
      if (wasActive || hadKeys || alwaysRelease) {
        const shouldSendNeutral = (wasActive || hadKeys) && driveModeRef.current === 'manual';
        void (async () => {
          if (shouldSendNeutral) {
            await resolvedApi.control.drive({ throttle: 0, steer: 0 }).catch(() => {});
          }
          await resolvedApi.control.releaseDrive().catch(() => {});
        })();
      }
    },
    [resolvedApi],
  );

  // Release drive when leaving manual mode or when 3D World stops being the active environment
  const prevManualActiveRef = useRef<boolean>(isWorldActive && driveMode === 'manual');
  useEffect(() => {
    const nowManualActive = isWorldActive && driveMode === 'manual';
    if (prevManualActiveRef.current && !nowManualActive) {
      const hadActiveDrive = driveActiveRef.current || pressedKeysRef.current.size > 0;
      pressedKeysRef.current.clear();
      driveActiveRef.current = false;
      setLastDriveCommand((prev) =>
        prev.throttle === 0 && prev.steer === 0 ? prev : { throttle: 0, steer: 0 },
      );
      void (async () => {
        if (hadActiveDrive) {
          await resolvedApi.control.drive({ throttle: 0, steer: 0 }).catch(() => {});
        }
        await resolvedApi.control.releaseDrive().catch(() => {});
      })();
    }
    prevManualActiveRef.current = nowManualActive;
  }, [driveMode, isWorldActive, resolvedApi]);

  // Release drive and disconnect control on WorldRoot unmount
  useEffect(() => {
    const pressedKeys = pressedKeysRef.current;
    return () => {
      const hadKeys = pressedKeys.size > 0;
      pressedKeys.clear();
      const wasDriving = (driveActiveRef.current || hadKeys) && driveModeRef.current === 'manual';
      const wasManual = driveModeRef.current === 'manual';
      driveActiveRef.current = false;
      void (async () => {
        if (wasDriving) {
          await resolvedApi.control.drive({ throttle: 0, steer: 0 }).catch(() => {});
        }
        if (wasManual || wasDriving) {
          await resolvedApi.control.releaseDrive().catch(() => {});
        }
        await resolvedApi.control.disconnect().catch(() => {});
      })();
    };
  }, [resolvedApi]);

  // Clear pressed keys and release drive on window blur or document visibilitychange to hidden
  useEffect(() => {
    const onBlur = (): void => {
      if (
        driveModeRef.current === 'manual' &&
        (driveActiveRef.current || pressedKeysRef.current.size > 0)
      ) {
        releaseActiveDrive(true);
      } else {
        pressedKeysRef.current.clear();
        driveActiveRef.current = false;
      }
    };
    const onVisibilityChange = (): void => {
      if (document.hidden || document.visibilityState === 'hidden') {
        onBlur();
      }
    };
    window.addEventListener('blur', onBlur);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      window.removeEventListener('blur', onBlur);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [releaseActiveDrive]);

  // Throttled paused drag state (at most one IPC call per animation frame, flushed on pointer-up)
  const pendingDragMoveRef = useRef<{
    id: string;
    positionM: { readonly x: number; readonly z: number };
    yawDeg: number;
    rollbackWorld: WorldFile;
  } | null>(null);
  const dragRafIdRef = useRef<number | null>(null);
  const dragOriginalWorldRef = useRef<Map<string, WorldFile>>(new Map());

  const dispatchPausedMoveIpc = useCallback(
    (
      id: string,
      positionM: { readonly x: number; readonly z: number },
      yawDeg: number,
      rollbackWorld: WorldFile,
    ): void => {
      void resolvedApi.worldEdit.moveObstacle(id, positionM, yawDeg).catch((err) => {
        const parsed = parseIpcError(err);
        if (parsed.code !== 'not-implemented') {
          worldFileRef.current = rollbackWorld;
          setWorldFile(rollbackWorld);
          reportError(err);
        }
      });
    },
    [reportError, resolvedApi.worldEdit],
  );

  const schedulePausedDragIpc = useCallback(
    (
      id: string,
      positionM: { readonly x: number; readonly z: number },
      yawDeg: number,
      rollbackWorld: WorldFile,
    ): void => {
      pendingDragMoveRef.current = { id, positionM, yawDeg, rollbackWorld };
      if (dragRafIdRef.current !== null) return;
      const schedule =
        typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function'
          ? window.requestAnimationFrame.bind(window)
          : (cb: FrameRequestCallback) => window.setTimeout(() => cb(performance.now()), 16);
      dragRafIdRef.current = schedule(() => {
        dragRafIdRef.current = null;
        const pending = pendingDragMoveRef.current;
        if (!pending) return;
        pendingDragMoveRef.current = null;
        dispatchPausedMoveIpc(pending.id, pending.positionM, pending.yawDeg, pending.rollbackWorld);
      });
    },
    [dispatchPausedMoveIpc],
  );

  const handleObstacleDragEnd = useCallback(
    (id: string): void => {
      if (dragRafIdRef.current !== null && typeof window.cancelAnimationFrame === 'function') {
        window.cancelAnimationFrame(dragRafIdRef.current);
        dragRafIdRef.current = null;
      }
      const pending = pendingDragMoveRef.current;
      pendingDragMoveRef.current = null;
      const rollbackWorld = dragOriginalWorldRef.current.get(id);
      dragOriginalWorldRef.current.delete(id);

      if (isPaused) {
        const currentObs = worldFileRef.current.obstacles.find((o) => o.id === id);
        if (pending && pending.id === id) {
          dispatchPausedMoveIpc(
            id,
            currentObs?.positionM ?? pending.positionM,
            currentObs?.yawDeg ?? pending.yawDeg,
            rollbackWorld ?? pending.rollbackWorld,
          );
        } else if (currentObs && rollbackWorld) {
          dispatchPausedMoveIpc(id, currentObs.positionM, currentObs.yawDeg, rollbackWorld);
        }
      }
    },
    [dispatchPausedMoveIpc, isPaused],
  );

  useEffect(() => {
    return () => {
      if (dragRafIdRef.current !== null && typeof window.cancelAnimationFrame === 'function') {
        window.cancelAnimationFrame(dragRafIdRef.current);
      }
    };
  }, []);

  // Obstacle editing actions
  const handlePlaceObstacleAt = useCallback(
    (groundPoint: { readonly x: number; readonly z: number }): void => {
      if (!editable || activeTool === 'select') return;
      const prevWorld = worldFileRef.current;
      const prevSelectedId = selectedObstacleIdRef.current;
      const point = placementCoordsTouched
        ? { x: placementX, z: placementZ }
        : { x: groundPoint.x, z: groundPoint.z };
      const yawDeg = placementYawDeg;
      const localId = generateUniqueObstacleId(activeTool, prevWorld.obstacles);
      const newObstacle: Obstacle = {
        id: localId,
        type: activeTool,
        positionM: { x: point.x, z: point.z },
        yawDeg,
      };

      const nextWorld: WorldFile = {
        ...prevWorld,
        obstacles: [...prevWorld.obstacles, newObstacle],
      };
      worldFileRef.current = nextWorld;
      setPlacementX(point.x);
      setPlacementZ(point.z);
      setWorldFile(nextWorld);
      setSelectedObstacleId(localId);

      if (isPaused) {
        void resolvedApi.worldEdit
          .addObstacle(newObstacle)
          .then((assignedId) => {
            if (assignedId && assignedId !== localId) {
              const updated: WorldFile = {
                ...worldFileRef.current,
                obstacles: worldFileRef.current.obstacles.map((o) =>
                  o.id === localId ? { ...o, id: assignedId } : o,
                ),
              };
              worldFileRef.current = updated;
              setWorldFile(updated);
              setSelectedObstacleId(assignedId);
            }
          })
          .catch((err) => {
            const parsed = parseIpcError(err);
            if (parsed.code !== 'not-implemented') {
              worldFileRef.current = prevWorld;
              setWorldFile(prevWorld);
              setSelectedObstacleId(prevSelectedId);
              reportError(err);
            }
          });
      }
    },
    [
      activeTool,
      editable,
      isPaused,
      placementCoordsTouched,
      placementX,
      placementYawDeg,
      placementZ,
      reportError,
      resolvedApi.worldEdit,
    ],
  );

  const handleMoveObstacleTo = useCallback(
    (
      id: string,
      point: { readonly x: number; readonly z: number },
      options?: { readonly dragging?: boolean },
    ): void => {
      if (!editable) return;
      const prevWorld = worldFileRef.current;
      const existing = prevWorld.obstacles.find((o) => o.id === id);
      if (!existing) return;

      if (options?.dragging && !dragOriginalWorldRef.current.has(id)) {
        dragOriginalWorldRef.current.set(id, prevWorld);
      }
      const rollbackWorld = dragOriginalWorldRef.current.get(id) ?? prevWorld;
      const currentYaw = existing.yawDeg;
      const nextPosition = { x: point.x, z: point.z };
      const nextWorld: WorldFile = {
        ...prevWorld,
        obstacles: prevWorld.obstacles.map((o) =>
          o.id === id ? { ...o, positionM: nextPosition } : o,
        ),
      };
      worldFileRef.current = nextWorld;
      setWorldFile(nextWorld);

      if (isPaused) {
        if (options?.dragging) {
          schedulePausedDragIpc(id, nextPosition, currentYaw, rollbackWorld);
        } else {
          dispatchPausedMoveIpc(id, nextPosition, currentYaw, rollbackWorld);
        }
      }
    },
    [dispatchPausedMoveIpc, editable, isPaused, schedulePausedDragIpc],
  );

  const handleRotateObstacleTo = useCallback(
    (id: string, yawDeg: number, options?: { readonly dragging?: boolean }): void => {
      if (!editable) return;
      const prevWorld = worldFileRef.current;
      const existing = prevWorld.obstacles.find((o) => o.id === id);
      if (!existing) return;

      if (options?.dragging && !dragOriginalWorldRef.current.has(id)) {
        dragOriginalWorldRef.current.set(id, prevWorld);
      }
      const rollbackWorld = dragOriginalWorldRef.current.get(id) ?? prevWorld;
      const currentPos = existing.positionM;
      const nextWorld: WorldFile = {
        ...prevWorld,
        obstacles: prevWorld.obstacles.map((o) => (o.id === id ? { ...o, yawDeg } : o)),
      };
      worldFileRef.current = nextWorld;
      setWorldFile(nextWorld);

      if (isPaused) {
        if (options?.dragging) {
          schedulePausedDragIpc(id, currentPos, yawDeg, rollbackWorld);
        } else {
          dispatchPausedMoveIpc(id, currentPos, yawDeg, rollbackWorld);
        }
      }
    },
    [dispatchPausedMoveIpc, editable, isPaused, schedulePausedDragIpc],
  );

  const handleDeleteObstacle = useCallback(
    (id: string): void => {
      if (!editable) return;
      const prevWorld = worldFileRef.current;
      const prevSelectedId = selectedObstacleIdRef.current;
      const nextWorld: WorldFile = {
        ...prevWorld,
        obstacles: prevWorld.obstacles.filter((o) => o.id !== id),
      };
      worldFileRef.current = nextWorld;
      setWorldFile(nextWorld);
      setSelectedObstacleId((prev) => (prev === id ? null : prev));

      if (isPaused) {
        void resolvedApi.worldEdit.removeObstacle(id).catch((err) => {
          const parsed = parseIpcError(err);
          if (parsed.code !== 'not-implemented') {
            worldFileRef.current = prevWorld;
            setWorldFile(prevWorld);
            setSelectedObstacleId(prevSelectedId);
            reportError(err);
          }
        });
      }
    },
    [editable, isPaused, reportError, resolvedApi.worldEdit],
  );

  // Keyboard listener for manual driving (WASD/arrows), E-stop (Space), and obstacle editing keys
  useEffect(() => {
    if (!isWorldActive) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      // On any modifier keydown (Meta, Control, Alt) or chord, clear held keys and release drive
      // so macOS Cmd-held keyup suppression never leaves a drive key stuck.
      if (isModifierKey(event.key) || event.ctrlKey || event.metaKey || event.altKey) {
        if (
          driveModeRef.current === 'manual' &&
          (pressedKeysRef.current.size > 0 || driveActiveRef.current)
        ) {
          releaseActiveDrive(true);
        } else {
          pressedKeysRef.current.clear();
          driveActiveRef.current = false;
        }
        return;
      }

      if (event.repeat) return;

      if (isEstopKey(event)) {
        // Space should not trigger E-stop while a button, input, select, or other interactive control has focus
        if (isInteractiveControlTarget(event.target)) return;
        event.preventDefault();
        pressedKeysRef.current.clear();
        driveActiveRef.current = false;
        setEstopLatched(true);
        setLastDriveCommand({ throttle: 0, steer: 0 });
        void (async () => {
          await ensureControlConnected({ force: true });
          await resolvedApi.control.estop().catch(() => {});
          await resolvedApi.control.releaseDrive().catch(() => {});
        })();
        return;
      }

      if (isEditableEventTarget(event.target)) return;

      if (event.key === 'Escape' && (selectedObstacleId || activeTool !== 'select')) {
        event.preventDefault();
        setSelectedObstacleId(null);
        setPlacementCoordsTouched(false);
        setActiveTool('select');
        return;
      }

      // Obstacle rotation & deletion shortcuts when an obstacle is selected and editable
      if (editable && selectedObstacleId) {
        const selectedObs = worldFileRef.current.obstacles.find((o) => o.id === selectedObstacleId);
        if (selectedObs) {
          if (event.key === 'Delete' || event.key === 'Backspace') {
            event.preventDefault();
            handleDeleteObstacle(selectedObstacleId);
            return;
          }
          if (event.key === '[' || event.key === 'q' || event.key === 'Q') {
            event.preventDefault();
            handleRotateObstacleTo(selectedObstacleId, selectedObs.yawDeg + 15);
            return;
          }
          if (
            event.key === ']' ||
            event.key === 'e' ||
            event.key === 'E' ||
            event.key === 'r' ||
            event.key === 'R'
          ) {
            event.preventDefault();
            handleRotateObstacleTo(selectedObstacleId, selectedObs.yawDeg - 15);
            return;
          }
        }
      }

      const dir = normalizeDriveKey(event.key);
      if (!dir) return;

      // Track keys and send drive commands strictly in manual mode
      if (driveMode !== 'manual' || estopLatched) return;

      pressedKeysRef.current.add(event.key);
      const sampled = sampleManualDriveInput(pressedKeysRef.current);
      driveActiveRef.current = sampled.active;
      sendDriveCommand(sampled.command);
    };

    const onKeyUp = (event: KeyboardEvent): void => {
      const dir = normalizeDriveKey(event.key);
      if (!dir) return;
      if (driveMode !== 'manual' || estopLatched) {
        pressedKeysRef.current.clear();
        return;
      }
      for (const k of [...pressedKeysRef.current]) {
        if (normalizeDriveKey(k) === dir) {
          pressedKeysRef.current.delete(k);
        }
      }
      const sampled = sampleManualDriveInput(pressedKeysRef.current);
      if (sampled.active) {
        sendDriveCommand(sampled.command);
      } else if (driveActiveRef.current) {
        releaseActiveDrive(true);
      }
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, [
    activeTool,
    driveMode,
    editable,
    ensureControlConnected,
    estopLatched,
    handleDeleteObstacle,
    handleRotateObstacleTo,
    isWorldActive,
    releaseActiveDrive,
    resolvedApi.control,
    selectedObstacleId,
    sendDriveCommand,
  ]);

  // 50 Hz manual driving interval for held keyboard keys and the Gamepad API
  useEffect(() => {
    if (!isWorldActive || driveMode !== 'manual' || estopLatched) return;
    const timer = window.setInterval(() => {
      const sampled = sampleManualDriveInput(pressedKeysRef.current);
      if (sampled.active) {
        driveActiveRef.current = true;
        sendDriveCommand(sampled.command);
      } else if (driveActiveRef.current) {
        releaseActiveDrive(true);
      }
    }, DRIVE_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [driveMode, estopLatched, isWorldActive, releaseActiveDrive, sendDriveCommand]);

  const handleToggleMode = async (nextMode: Mode): Promise<void> => {
    const wasManual = driveModeRef.current === 'manual';
    const wasDriving = wasManual && (driveActiveRef.current || pressedKeysRef.current.size > 0);
    pressedKeysRef.current.clear();
    driveActiveRef.current = false;
    driveModeRef.current = nextMode;
    setLastDriveCommand((prev) =>
      prev.throttle === 0 && prev.steer === 0 ? prev : { throttle: 0, steer: 0 },
    );
    setDriveMode(nextMode);
    setEstopLatched(false);
    await ensureControlConnected({ force: true });
    if (wasManual && nextMode !== 'manual') {
      if (wasDriving) {
        await resolvedApi.control.drive({ throttle: 0, steer: 0 }).catch(() => {});
      }
      await resolvedApi.control.releaseDrive().catch(() => {});
    }
    await resolvedApi.control.setMode(nextMode).catch(reportError);
  };

  const handleEstop = async (): Promise<void> => {
    pressedKeysRef.current.clear();
    driveActiveRef.current = false;
    setEstopLatched(true);
    setLastDriveCommand({ throttle: 0, steer: 0 });
    await ensureControlConnected({ force: true });
    await resolvedApi.control.estop().catch(reportError);
    await resolvedApi.control.releaseDrive().catch(() => {});
  };

  const handleRunOrPause = async (): Promise<void> => {
    setErrorMessage('');
    try {
      if (!runInfo || runInfo.state === 'ended') {
        await prepareRun?.();
        const prevState = runInfoRef.current?.state;
        const nextWorld: WorldFile = { ...worldFileRef.current, seed };
        const started = await resolvedApi.run.start({ world: nextWorld, seed, speed });
        const statusAlreadyHandled =
          runInfoRef.current?.state === started.state && prevState !== started.state;
        runInfoRef.current = started;
        setRunInfo(started);
        if (!statusAlreadyHandled) {
          connectFailuresRef.current = 0;
          lastConnectFailAtMsRef.current = -Infinity;
          void ensureControlConnected({ force: true });
        }
      } else if (runInfo.state === 'running') {
        await resolvedApi.run.pause();
      } else if (runInfo.state === 'paused') {
        await resolvedApi.run.resume();
      }
    } catch (err) {
      setErrorMessage(parseIpcError(err).message);
    }
  };

  const handleStopRun = async (): Promise<void> => {
    setErrorMessage('');
    try {
      await resolvedApi.run.stop();
      resetSnapshotState();
    } catch (err) {
      setErrorMessage(parseIpcError(err).message);
    }
  };

  const handleStepRun = async (): Promise<void> => {
    setErrorMessage('');
    try {
      await resolvedApi.run.step(1);
    } catch (err) {
      setErrorMessage(parseIpcError(err).message);
    }
  };

  const handleSpeedChange = async (nextSpeed: RunSpeed): Promise<void> => {
    setSpeed(nextSpeed);
    if (runInfo && runInfo.state !== 'ended') {
      try {
        await resolvedApi.run.setSpeed(nextSpeed);
      } catch (err) {
        setErrorMessage(parseIpcError(err).message);
      }
    }
  };

  const handleSaveLayout = async (): Promise<void> => {
    setErrorMessage('');
    setStatusMessage('');
    try {
      const targetPath = normalizeLayoutPath(layoutPath);
      setLayoutPath(targetPath);
      let payload: WorldFile = { ...worldFileRef.current, seed };
      if (isPaused) {
        try {
          const live = await resolvedApi.worldEdit.currentLayout();
          payload = ensureWorldObstacleIds({
            ...live,
            seed,
            obstacles:
              worldFileRef.current.obstacles.length > 0
                ? worldFileRef.current.obstacles
                : live.obstacles,
          });
        } catch {
          // Use local worldFile when no active live layout in main
        }
      }
      await resolvedApi.worldEdit.save(targetPath, World.parse(payload));
      setStatusMessage(`Saved ${targetPath}`);
      const layouts = await resolvedApi.worldEdit
        .listLayouts()
        .catch(() =>
          layoutPaths.includes(targetPath) ? layoutPaths : [...layoutPaths, targetPath],
        );
      setLayoutPaths(layouts);
    } catch (err) {
      setErrorMessage(parseIpcError(err).message);
    }
  };

  const handleLoadLayout = async (pathToLoad = layoutPath): Promise<void> => {
    setErrorMessage('');
    setStatusMessage('');
    try {
      const targetPath = normalizeLayoutPath(pathToLoad);
      const parsedWorld = World.parse(await resolvedApi.worldEdit.load(targetPath));
      const loaded = ensureWorldObstacleIds(parsedWorld);
      worldFileRef.current = loaded;
      setWorldFile(loaded);
      setSeed(loaded.seed);
      setLayoutPath(targetPath);
      setSelectedObstacleId(null);
      const loadedTrack = await loadTrackById(loaded.trackId, { resetInterpolator: true });
      resetSnapshotState(loaded, loadedTrack);
      setStatusMessage(`Loaded ${targetPath}`);
    } catch (err) {
      setErrorMessage(parseIpcError(err).message);
    }
  };

  const selectedObstacle = worldFile.obstacles.find((o) => o.id === selectedObstacleId) ?? null;
  const dockTabs = useMemo(() => createWorldDockTabs(resolvedApi), [resolvedApi]);

  useEffect(() => {
    if (latestSnapshotRef.current) {
      updateReadoutsDom(latestSnapshotRef.current);
    }
  });

  return (
    <section
      className="world-environment"
      aria-label="3D World environment"
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        minHeight: 0,
        background: '#10171e',
        color: '#d1dce5',
      }}
    >
      {/* Top toolbar: Run controls & readouts */}
      <header
        data-testid="world-run-toolbar"
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          gap: 10,
          padding: '8px 14px',
          background: '#151e27',
          borderBottom: '1px solid #2b3947',
          flexShrink: 0,
        }}
      >
        <h1 style={{ margin: 0, fontSize: 16, fontWeight: 600, marginRight: 6 }}>3D World</h1>

        <div
          role="group"
          aria-label="Run controls"
          style={{ display: 'flex', alignItems: 'center', gap: 6 }}
        >
          <button
            type="button"
            className="primary"
            data-testid="run-play-pause-btn"
            onClick={() => void handleRunOrPause()}
          >
            {isRunning ? 'Pause' : isPaused ? 'Resume' : 'Run'}
          </button>
          <button
            type="button"
            data-testid="run-stop-btn"
            disabled={!runInfo || runInfo.state === 'ended'}
            onClick={() => void handleStopRun()}
          >
            Stop
          </button>
          <button
            type="button"
            data-testid="run-step-btn"
            disabled={!isPaused}
            onClick={() => void handleStepRun()}
          >
            Step
          </button>

          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12 }}>
            <span>Speed</span>
            <select
              aria-label="Simulation speed"
              value={String(speed)}
              onChange={(e) => {
                const raw = e.target.value;
                const next: RunSpeed = raw === 'unpaced' ? 'unpaced' : (Number(raw) as RunSpeed);
                void handleSpeedChange(next);
              }}
            >
              {RUN_SPEEDS.map((s) => (
                <option key={String(s)} value={String(s)}>
                  {s === 'unpaced' ? 'Unpaced' : `${s}\u00d7`}
                </option>
              ))}
            </select>
          </label>

          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12 }}>
            <span>Seed</span>
            <input
              type="number"
              aria-label="Seed"
              min={0}
              max={0xffff_ffff}
              disabled={isRunning || isPaused}
              value={seed}
              onChange={(e) => {
                const parsed = Number.parseInt(e.target.value, 10);
                const nextSeed = Number.isFinite(parsed)
                  ? Math.max(0, Math.min(0xffff_ffff, parsed))
                  : 0;
                setSeed(nextSeed);
                setWorldFile((prev) => {
                  const next = { ...prev, seed: nextSeed };
                  worldFileRef.current = next;
                  return next;
                });
              }}
              style={{ width: 72, padding: '4px 6px' }}
            />
          </label>
        </div>

        {/* Sim readouts: time, laps, collisions (updated imperatively on snapshot arrival) */}
        <div
          data-testid="world-sim-readouts"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 14,
            fontSize: 12,
            padding: '4px 10px',
            background: '#10171e',
            border: '1px solid #2b3947',
            borderRadius: 4,
          }}
        >
          <span ref={simTimeRef} data-testid="sim-time-display">
            <strong>Sim time:</strong> 0.000 s
          </span>
          <span ref={lapCounterRef} data-testid="lap-counter">
            <strong>Laps:</strong> 0
          </span>
          <span ref={collisionCountRef} data-testid="collision-count">
            <strong>Collisions:</strong> 0
          </span>
        </div>

        {/* Driving controls: Manual/Auto mode toggle, E-stop */}
        <div
          role="group"
          aria-label="Driving controls"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            marginLeft: 'auto',
          }}
        >
          <button
            type="button"
            aria-label="Manual mode"
            aria-pressed={driveMode === 'manual'}
            onClick={() => void handleToggleMode('manual')}
            style={{
              background: driveMode === 'manual' ? '#233b39' : undefined,
              color: driveMode === 'manual' ? '#84ddbf' : undefined,
              borderColor: driveMode === 'manual' ? '#84ddbf' : undefined,
            }}
          >
            Manual
          </button>
          <button
            type="button"
            aria-label="Auto mode"
            aria-pressed={driveMode === 'auto'}
            onClick={() => void handleToggleMode('auto')}
            style={{
              background: driveMode === 'auto' ? '#233b39' : undefined,
              color: driveMode === 'auto' ? '#84ddbf' : undefined,
              borderColor: driveMode === 'auto' ? '#84ddbf' : undefined,
            }}
          >
            Auto
          </button>
          <span
            data-testid="drive-command-readout"
            style={{ fontSize: 11, color: '#9dafbe', minWidth: 115 }}
          >
            T: {lastDriveCommand.throttle.toFixed(2)} | S: {lastDriveCommand.steer.toFixed(2)}
          </span>
          <button
            type="button"
            aria-label="E-stop"
            data-testid="estop-button"
            onClick={() => void handleEstop()}
            style={{
              background: '#dc2626',
              color: '#ffffff',
              borderColor: '#ef4444',
              fontWeight: 700,
            }}
          >
            E-STOP (Space)
          </button>
        </div>
      </header>

      {/* Secondary toolbar: Obstacle editing palette, Track/Layout save/load, Camera selector */}
      <div
        data-testid="world-editor-toolbar"
        style={{
          display: 'flex',
          flexWrap: 'nowrap',
          alignItems: 'center',
          gap: 10,
          minHeight: 38,
          padding: '6px 14px',
          background: '#141d26',
          borderBottom: '1px solid #2b3947',
          fontSize: 12,
          flexShrink: 0,
          overflowX: 'auto',
          overflowY: 'hidden',
          whiteSpace: 'nowrap',
        }}
      >
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
          <span>Track</span>
          <select
            aria-label="Track"
            disabled={!editable || isPaused}
            value={worldFile.trackId}
            onChange={(e) => {
              const nextTrackId = e.target.value;
              const nextWorld: WorldFile = { ...worldFileRef.current, trackId: nextTrackId };
              worldFileRef.current = nextWorld;
              setWorldFile(nextWorld);
              void loadTrackById(nextTrackId, { resetInterpolator: true });
            }}
          >
            {trackIds.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>
        </label>

        {/* Obstacle palette */}
        <div
          role="group"
          aria-label="Obstacle palette"
          style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}
        >
          {PALETTE_TOOLS.map((tool) => (
            <button
              key={tool.id}
              type="button"
              data-testid={`palette-tool-${tool.id}`}
              disabled={!editable}
              aria-pressed={activeTool === tool.id}
              onClick={() => {
                setPlacementCoordsTouched(false);
                setActiveTool(tool.id);
              }}
              style={{
                background: activeTool === tool.id ? '#233b39' : undefined,
                color: activeTool === tool.id ? '#84ddbf' : undefined,
                borderColor: activeTool === tool.id ? '#84ddbf' : undefined,
              }}
            >
              {tool.label}
            </button>
          ))}
        </div>

        {/* Placement coordinate controls */}
        <div
          role="group"
          aria-label="Placement coordinates"
          style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}
        >
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
            <span>X</span>
            <input
              type="number"
              step="0.1"
              aria-label="Placement X (m)"
              disabled={!editable}
              value={placementX}
              onChange={(e) => {
                const v = Number.parseFloat(e.target.value);
                if (Number.isFinite(v)) {
                  setPlacementX(v);
                  setPlacementCoordsTouched(true);
                }
              }}
              style={{ width: 58, padding: '3px 5px' }}
            />
          </label>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
            <span>Z</span>
            <input
              type="number"
              step="0.1"
              aria-label="Placement Z (m)"
              disabled={!editable}
              value={placementZ}
              onChange={(e) => {
                const v = Number.parseFloat(e.target.value);
                if (Number.isFinite(v)) {
                  setPlacementZ(v);
                  setPlacementCoordsTouched(true);
                }
              }}
              style={{ width: 58, padding: '3px 5px' }}
            />
          </label>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
            <span>Yaw°</span>
            <input
              type="number"
              step="5"
              aria-label="Placement yaw (deg)"
              disabled={!editable}
              value={placementYawDeg}
              onChange={(e) => {
                const v = Number.parseFloat(e.target.value);
                if (Number.isFinite(v)) setPlacementYawDeg(v);
              }}
              style={{ width: 58, padding: '3px 5px' }}
            />
          </label>
        </div>

        {/* Selected obstacle quick actions */}
        {selectedObstacle && (
          <div
            role="group"
            aria-label="Selected obstacle controls"
            data-testid="selected-obstacle-controls"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 5,
              padding: '2px 8px',
              background: '#1c2732',
              borderRadius: 4,
              border: '1px solid #344352',
              flexShrink: 0,
            }}
          >
            <span>
              <strong>{selectedObstacle.type}</strong> ({selectedObstacle.id})
            </span>
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
              <span>X</span>
              <input
                type="number"
                step="0.1"
                aria-label="Selected obstacle X (m)"
                disabled={!editable}
                value={selectedObstacle.positionM.x}
                onChange={(e) => {
                  const v = Number.parseFloat(e.target.value);
                  if (Number.isFinite(v) && selectedObstacle.id) {
                    handleMoveObstacleTo(selectedObstacle.id, {
                      x: v,
                      z: selectedObstacle.positionM.z,
                    });
                  }
                }}
                style={{ width: 56, padding: '2px 4px' }}
              />
            </label>
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
              <span>Z</span>
              <input
                type="number"
                step="0.1"
                aria-label="Selected obstacle Z (m)"
                disabled={!editable}
                value={selectedObstacle.positionM.z}
                onChange={(e) => {
                  const v = Number.parseFloat(e.target.value);
                  if (Number.isFinite(v) && selectedObstacle.id) {
                    handleMoveObstacleTo(selectedObstacle.id, {
                      x: selectedObstacle.positionM.x,
                      z: v,
                    });
                  }
                }}
                style={{ width: 56, padding: '2px 4px' }}
              />
            </label>
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
              <span>Yaw</span>
              <input
                type="number"
                step="5"
                aria-label="Selected obstacle yaw (deg)"
                disabled={!editable}
                value={selectedObstacle.yawDeg}
                onChange={(e) => {
                  const v = Number.parseFloat(e.target.value);
                  if (Number.isFinite(v) && selectedObstacle.id) {
                    handleRotateObstacleTo(selectedObstacle.id, v);
                  }
                }}
                style={{ width: 56, padding: '2px 4px' }}
              />
            </label>
            <button
              type="button"
              disabled={!editable}
              aria-label="Rotate left 15°"
              onClick={() => {
                if (selectedObstacle.id) {
                  handleRotateObstacleTo(selectedObstacle.id, selectedObstacle.yawDeg + 15);
                }
              }}
            >
              ↺ +15°
            </button>
            <button
              type="button"
              disabled={!editable}
              aria-label="Rotate right 15°"
              onClick={() => {
                if (selectedObstacle.id) {
                  handleRotateObstacleTo(selectedObstacle.id, selectedObstacle.yawDeg - 15);
                }
              }}
            >
              ↻ -15°
            </button>
            <button
              type="button"
              disabled={!editable}
              aria-label="Delete obstacle"
              onClick={() => {
                if (selectedObstacle.id) {
                  handleDeleteObstacle(selectedObstacle.id);
                }
              }}
            >
              Delete
            </button>
          </div>
        )}

        {/* Save / Load world layouts */}
        <div
          role="group"
          aria-label="World layout files"
          style={{ display: 'flex', alignItems: 'center', gap: 5, flexShrink: 0 }}
        >
          <input
            type="text"
            aria-label="Layout path"
            value={layoutPath}
            onChange={(e) => setLayoutPath(e.target.value)}
            style={{ width: 155, padding: '4px 6px' }}
          />
          <button
            type="button"
            data-testid="world-save-btn"
            disabled={!editable}
            onClick={() => void handleSaveLayout()}
          >
            Save layout
          </button>
          {layoutPaths.length > 0 && (
            <select
              aria-label="Saved layouts"
              value=""
              disabled={!editable || isPaused}
              onChange={(e) => {
                if (e.target.value) void handleLoadLayout(e.target.value);
              }}
            >
              <option value="">Load saved…</option>
              {layoutPaths.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          )}
          <button
            type="button"
            data-testid="world-load-btn"
            disabled={!editable || isPaused}
            onClick={() => void handleLoadLayout(layoutPath)}
          >
            Load layout
          </button>
        </div>

        {/* Camera selector */}
        <div
          role="group"
          aria-label="Camera mode"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 4,
            marginLeft: 'auto',
            flexShrink: 0,
          }}
        >
          {CAMERA_MODES.map((mode) => (
            <button
              key={mode}
              type="button"
              data-testid={`camera-mode-${mode}`}
              aria-pressed={cameraMode === mode}
              onClick={() => setCameraMode(mode)}
              style={{
                background: cameraMode === mode ? '#233b39' : undefined,
                color: cameraMode === mode ? '#84ddbf' : undefined,
                borderColor: cameraMode === mode ? '#84ddbf' : undefined,
              }}
            >
              {CAMERA_LABELS[mode]}
            </button>
          ))}
        </div>
      </div>

      {errorMessage ? (
        <div className="notice app-notice" role="alert">
          <span>{errorMessage}</span>
          <button
            type="button"
            aria-label="Dismiss world error"
            onClick={() => setErrorMessage('')}
          >
            ×
          </button>
        </div>
      ) : null}

      {statusMessage ? (
        <div
          role="status"
          data-testid="world-status-message"
          style={{
            padding: '4px 14px',
            fontSize: 11,
            background: '#162825',
            color: '#84ddbf',
            borderBottom: '1px solid #233b39',
          }}
        >
          {statusMessage}
        </div>
      ) : null}

      {/* 3D World Scene Viewport */}
      {sceneData ? (
        <WorldScene
          viewportRef={viewportRef}
          sceneData={sceneData}
          cameraMode={cameraMode}
          orbitState={orbitState}
          onOrbitChange={setOrbitState}
          interpolator={interpolator}
          runMode={sceneRunMode}
          active={isWorldActive}
          editable={editable}
          activeTool={activeTool}
          selectedObstacleId={selectedObstacleId}
          onSelectObstacle={setSelectedObstacleId}
          onPlaceObstacleAt={handlePlaceObstacleAt}
          onMoveObstacleTo={handleMoveObstacleTo}
          onRotateObstacleTo={handleRotateObstacleTo}
          onObstacleDragEnd={handleObstacleDragEnd}
        />
      ) : null}

      {/* Optional standalone BottomPanel when showDock is explicitly passed in tests */}
      {showDock ? (
        <BottomPanel api={resolvedApi} projectDir="/project" jump={() => {}} tabs={dockTabs} />
      ) : null}
    </section>
  );
}
