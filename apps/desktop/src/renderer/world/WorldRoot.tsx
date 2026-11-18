import type { Mode } from '@rcsim/control-protocol/messages';
import {
  SCHEMA_VERSION,
  World,
  type Obstacle,
  type Track,
  type World as WorldFile,
} from '@rcsim/schema';
import type { StateSnapshot } from '@rcsim/sim-core/api';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import {
  RUN_SPEEDS,
  parseIpcError,
  type RcsimApi,
  type RunInfo,
  type RunSpeed,
} from '../../shared/ipc.ts';
import { BottomPanel, type DockTab } from '../shell/BottomPanel.tsx';
import { useEnvironmentStore } from '../shell/environment-store.ts';
import { useSessionStore } from '../shell/session.ts';
import {
  DRIVE_INTERVAL_MS,
  isEditableEventTarget,
  isEstopKey,
  normalizeDriveKey,
  sampleManualDriveInput,
  type DriveCommandInput,
} from './driving-controller.ts';
import { SnapshotInterpolator } from './interpolation.ts';
import { NetworkConsole } from './NetworkConsole.tsx';
import {
  CAMERA_MODES,
  DEFAULT_ORBIT_CAMERA,
  buildWorldSceneData,
  defaultSnapshotForWorld,
  syncThreeSceneGraph,
  type CameraMode,
  type OrbitCameraState,
} from './scene-data.ts';
import { BUILTIN_OVAL_TRACK, BUILTIN_TRACKS } from './track-mesh.ts';
import { WorldScene, type EditorTool } from './WorldScene.tsx';
import * as THREE from 'three';

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

function normalizeLayoutPath(raw: string): string {
  const trimmed = raw.trim() || 'worlds/oval-cones.json';
  const withPrefix = trimmed.startsWith('worlds/') ? trimmed : `worlds/${trimmed}`;
  return withPrefix.endsWith('.json') ? withPrefix : `${withPrefix}.json`;
}

/** Shared latest Three.js scene graph for test inspection. */
let latestThreeSceneGraph: THREE.Group = new THREE.Group();

export function getWorldThreeScene(): THREE.Group {
  return latestThreeSceneGraph;
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
}

/** Root of the 3D World environment (P1-F). */
export function WorldRoot({ api = window.rcsim, initialWorld }: WorldRootProps = {}): ReactNode {
  const rootRef = useRef<HTMLElement>(null);
  const threeSceneRef = useRef<THREE.Group>(new THREE.Group());
  const [interpolator] = useState<SnapshotInterpolator>(() => new SnapshotInterpolator());

  const [trackIds, setTrackIds] = useState<readonly string[]>(['oval', 'technical']);
  const [track, setTrack] = useState<Track>(BUILTIN_OVAL_TRACK);
  const [worldFile, setWorldFile] = useState<WorldFile>(initialWorld ?? DEFAULT_WORLD_FILE);
  const [layoutPaths, setLayoutPaths] = useState<readonly string[]>([]);
  const [layoutPath, setLayoutPath] = useState('worlds/oval-cones.json');
  const [statusMessage, setStatusMessage] = useState('');
  const [errorMessage, setErrorMessage] = useState('');

  // Run state
  const [runInfo, setRunInfo] = useState<RunInfo | null>(null);
  const [speed, setSpeed] = useState<RunSpeed>(1);
  const [seed, setSeed] = useState<number>((initialWorld ?? DEFAULT_WORLD_FILE).seed);
  const [latestSnapshot, setLatestSnapshot] = useState<StateSnapshot | null>(null);

  // Camera & scene editor state
  const [cameraMode, setCameraMode] = useState<CameraMode>('orbit');
  const [orbitState, setOrbitState] = useState<OrbitCameraState>(DEFAULT_ORBIT_CAMERA);
  const [activeTool, setActiveTool] = useState<EditorTool>('select');
  const [selectedObstacleId, setSelectedObstacleId] = useState<string | null>(null);
  const [placementX, setPlacementX] = useState<number>(2.4);
  const [placementZ, setPlacementZ] = useState<number>(-1.5);
  const [placementYawDeg, setPlacementYawDeg] = useState<number>(0);
  const [placementCoordsTouched, setPlacementCoordsTouched] = useState(false);
  const nextObstacleCounterRef = useRef(1);

  // Driving state
  const [driveMode, setDriveMode] = useState<Mode>('manual');
  const [estopLatched, setEstopLatched] = useState(false);
  const [lastDriveCommand, setLastDriveCommand] = useState<DriveCommandInput>({
    throttle: 0,
    steer: 0,
  });
  const pressedKeysRef = useRef<Set<string>>(new Set());
  const driveActiveRef = useRef(false);
  const controlConnectedRef = useRef(false);

  // Shared bottom panel detection (when hosted inside App with an open project)
  const currentEnv = useEnvironmentStore((state) => state.current);
  const panel = useSessionStore((state) => state.panel);
  const panelOpen = useSessionStore((state) => state.panelOpen);
  const showPanel = useSessionStore((state) => state.showPanel);
  const [isHostedInApp, setIsHostedInApp] = useState<boolean>(
    () => typeof document !== 'undefined' && document.querySelector('.app-shell') !== null,
  );
  const [outerDockTargets, setOuterDockTargets] = useState<{
    readonly tablist: Element;
    readonly content: Element;
  } | null>(null);

  const isWorldActive = !isHostedInApp || currentEnv === 'world';

  const reportError = useCallback((err: unknown): void => {
    const parsed = parseIpcError(err);
    if (parsed.code === 'not-implemented') return;
    setErrorMessage(parsed.message);
  }, []);

  const loadTrackById = useCallback(
    async (id: string): Promise<Track> => {
      try {
        const loaded = await api.worldEdit.loadTrack(id);
        setTrack(loaded);
        return loaded;
      } catch (err) {
        const parsed = parseIpcError(err);
        const fallback = BUILTIN_TRACKS[id] ?? BUILTIN_OVAL_TRACK;
        if (parsed.code === 'not-implemented') {
          setTrack(fallback);
          return fallback;
        }
        setErrorMessage(parsed.message);
        setTrack(fallback);
        return fallback;
      }
    },
    [api],
  );

  // Discover tracks, layouts, and initial run state
  useEffect(() => {
    let alive = true;
    void api.worldEdit
      .listTracks()
      .then((ids) => {
        if (alive && ids.length > 0) setTrackIds(ids);
      })
      .catch(() => {});

    void api.worldEdit
      .loadTrack(worldFile.trackId)
      .then((loaded) => {
        if (alive) setTrack(loaded);
      })
      .catch((err) => {
        if (!alive) return;
        const parsed = parseIpcError(err);
        const fallback = BUILTIN_TRACKS[worldFile.trackId] ?? BUILTIN_OVAL_TRACK;
        setTrack(fallback);
        if (parsed.code !== 'not-implemented') {
          setErrorMessage(parsed.message);
        }
      });

    void api.worldEdit
      .listLayouts()
      .then((paths) => {
        if (alive) {
          setLayoutPaths(paths);
          if (paths[0]) setLayoutPath(paths[0]);
        }
      })
      .catch(() => {});

    void api.run
      .info()
      .then((info) => {
        if (alive && info) {
          setRunInfo(info);
          setSpeed(info.speed);
          setSeed(info.seed);
        }
      })
      .catch(() => {});

    const offStatus = api.run.onStatus((info) => {
      if (!alive) return;
      setRunInfo(info);
      setSpeed(info.speed);
      setSeed(info.seed);
      if (info.trackId) {
        void loadTrackById(info.trackId);
      }
    });

    const offSnapshot = api.run.onSnapshot((snapshot) => {
      if (!alive) return;
      interpolator.push(snapshot, performance.now());
      setLatestSnapshot(snapshot);
    });

    const offControlState = api.control.onState((state) => {
      controlConnectedRef.current = state === 'connected';
    });

    return () => {
      alive = false;
      offStatus();
      offSnapshot();
      offControlState();
    };
  }, [api, interpolator, loadTrackById, worldFile.trackId]);

  // Detect whether App has already mounted an outer Shared bottom panel
  useEffect(() => {
    const hosted = Boolean(rootRef.current?.closest('.app-shell'));
    setIsHostedInApp(hosted);
    const allDocks = Array.from(document.querySelectorAll('[aria-label="Shared bottom panel"]'));
    const outer = allDocks.find((el) => !rootRef.current?.contains(el));
    if (!outer) {
      setOuterDockTargets((prev) => (prev === null ? prev : null));
      return;
    }
    const tablist = outer.querySelector('[role="tablist"][aria-label="Panel tabs"]');
    const content = outer.querySelector('.dock-content');
    if (tablist && content) {
      setOuterDockTargets((prev) =>
        prev && prev.tablist === tablist && prev.content === content ? prev : { tablist, content },
      );
    } else {
      setOuterDockTargets((prev) => (prev === null ? prev : null));
    }
  }, []);

  const isRunning = runInfo?.state === 'running' || runInfo?.state === 'starting';
  const isPaused = runInfo?.state === 'paused';
  const editable = !isRunning;

  // Build effective snapshot for rendering: live snapshot when present, merged with editor obstacles while stopped
  const effectiveSnapshot = useMemo<StateSnapshot>(() => {
    const fallback = defaultSnapshotForWorld(worldFile, track);
    if (!latestSnapshot) return fallback;
    if (!runInfo || runInfo.state === 'ended') {
      // When stopped after a run or when snapshots are fed externally in tests:
      // if the user placed obstacles in the editor that aren't in the snapshot yet, include them
      if (worldFile.obstacles.length > 0 && latestSnapshot.obstacles.length === 0) {
        return {
          ...latestSnapshot,
          obstacles: fallback.obstacles,
        };
      }
    }
    return latestSnapshot;
  }, [latestSnapshot, runInfo, track, worldFile]);

  const sceneData = useMemo(
    () => buildWorldSceneData(effectiveSnapshot, track, selectedObstacleId),
    [effectiveSnapshot, selectedObstacleId, track],
  );

  // Keep the real Three.js scene graph synchronized with sceneData
  useEffect(() => {
    syncThreeSceneGraph(threeSceneRef.current, sceneData);
    latestThreeSceneGraph = threeSceneRef.current;
  }, [sceneData]);

  const ensureControlConnected = useCallback(async (): Promise<void> => {
    if (controlConnectedRef.current) return;
    try {
      await api.control.connect({ kind: 'run' });
      controlConnectedRef.current = true;
    } catch {
      // Ignore if main control stub is not implemented yet
    }
  }, [api]);

  const sendDriveCommand = useCallback(
    (command: DriveCommandInput): void => {
      setLastDriveCommand(command);
      void (async () => {
        await ensureControlConnected();
        await api.control.drive(command).catch(() => {});
      })();
    },
    [api, ensureControlConnected],
  );

  // Obstacle editing actions
  const handlePlaceObstacleAt = useCallback(
    (groundPoint: { readonly x: number; readonly z: number }): void => {
      if (!editable || activeTool === 'select') return;
      const point = placementCoordsTouched
        ? { x: placementX, z: placementZ }
        : { x: groundPoint.x, z: groundPoint.z };
      const yawDeg = placementYawDeg;
      const localId = `${activeTool}-${nextObstacleCounterRef.current++}`;
      const newObstacle: Obstacle = {
        id: localId,
        type: activeTool,
        positionM: { x: point.x, z: point.z },
        yawDeg,
      };

      setPlacementX(point.x);
      setPlacementZ(point.z);
      setWorldFile((prev) => ({
        ...prev,
        obstacles: [...prev.obstacles, newObstacle],
      }));
      setSelectedObstacleId(localId);

      if (isPaused) {
        void api.worldEdit
          .addObstacle(newObstacle)
          .then((assignedId) => {
            if (assignedId && assignedId !== localId) {
              setWorldFile((prev) => ({
                ...prev,
                obstacles: prev.obstacles.map((o) =>
                  o.id === localId ? { ...o, id: assignedId } : o,
                ),
              }));
              setSelectedObstacleId(assignedId);
            }
          })
          .catch(reportError);
      }
    },
    [
      activeTool,
      api.worldEdit,
      editable,
      isPaused,
      placementCoordsTouched,
      placementX,
      placementYawDeg,
      placementZ,
      reportError,
    ],
  );

  const handleMoveObstacleTo = useCallback(
    (id: string, point: { readonly x: number; readonly z: number }): void => {
      if (!editable) return;
      let currentYaw = 0;
      setWorldFile((prev) => ({
        ...prev,
        obstacles: prev.obstacles.map((o) => {
          if (o.id === id) {
            currentYaw = o.yawDeg;
            return { ...o, positionM: { x: point.x, z: point.z } };
          }
          return o;
        }),
      }));
      if (isPaused) {
        void api.worldEdit.moveObstacle(id, point, currentYaw).catch(reportError);
      }
    },
    [api.worldEdit, editable, isPaused, reportError],
  );

  const handleRotateObstacleTo = useCallback(
    (id: string, yawDeg: number): void => {
      if (!editable) return;
      let currentPos = { x: 0, z: 0 };
      setWorldFile((prev) => ({
        ...prev,
        obstacles: prev.obstacles.map((o) => {
          if (o.id === id) {
            currentPos = o.positionM;
            return { ...o, yawDeg };
          }
          return o;
        }),
      }));
      if (isPaused) {
        void api.worldEdit.moveObstacle(id, currentPos, yawDeg).catch(reportError);
      }
    },
    [api.worldEdit, editable, isPaused, reportError],
  );

  const handleDeleteObstacle = useCallback(
    (id: string): void => {
      if (!editable) return;
      setWorldFile((prev) => ({
        ...prev,
        obstacles: prev.obstacles.filter((o) => o.id !== id),
      }));
      setSelectedObstacleId((prev) => (prev === id ? null : prev));
      if (isPaused) {
        void api.worldEdit.removeObstacle(id).catch(reportError);
      }
    },
    [api.worldEdit, editable, isPaused, reportError],
  );

  // Keyboard listener for manual driving (WASD/arrows), E-stop (Space), and obstacle editing keys
  useEffect(() => {
    if (!isWorldActive) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (isEditableEventTarget(event.target)) return;

      if (isEstopKey(event)) {
        event.preventDefault();
        pressedKeysRef.current.clear();
        driveActiveRef.current = false;
        setEstopLatched(true);
        setLastDriveCommand({ throttle: 0, steer: 0 });
        void (async () => {
          await ensureControlConnected();
          await api.control.estop().catch(() => {});
          await api.control.releaseDrive().catch(() => {});
        })();
        return;
      }

      // Obstacle rotation & deletion shortcuts when an obstacle is selected and editable
      if (editable && selectedObstacleId) {
        const selectedObs = worldFile.obstacles.find((o) => o.id === selectedObstacleId);
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

      pressedKeysRef.current.add(event.key);
      if (driveMode === 'manual' && !estopLatched) {
        const sampled = sampleManualDriveInput(pressedKeysRef.current);
        driveActiveRef.current = sampled.active;
        sendDriveCommand(sampled.command);
      }
    };

    const onKeyUp = (event: KeyboardEvent): void => {
      const dir = normalizeDriveKey(event.key);
      if (!dir) return;
      for (const k of [...pressedKeysRef.current]) {
        if (normalizeDriveKey(k) === dir) {
          pressedKeysRef.current.delete(k);
        }
      }
      if (driveMode === 'manual' && !estopLatched) {
        const sampled = sampleManualDriveInput(pressedKeysRef.current);
        if (sampled.active) {
          sendDriveCommand(sampled.command);
        } else if (driveActiveRef.current) {
          driveActiveRef.current = false;
          sendDriveCommand({ throttle: 0, steer: 0 });
          void api.control.releaseDrive().catch(() => {});
        }
      }
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, [
    api.control,
    driveMode,
    editable,
    ensureControlConnected,
    estopLatched,
    handleDeleteObstacle,
    handleRotateObstacleTo,
    isWorldActive,
    selectedObstacleId,
    sendDriveCommand,
    worldFile.obstacles,
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
        driveActiveRef.current = false;
        sendDriveCommand({ throttle: 0, steer: 0 });
        void api.control.releaseDrive().catch(() => {});
      }
    }, DRIVE_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [api.control, driveMode, estopLatched, isWorldActive, sendDriveCommand]);

  const handleToggleMode = async (nextMode: Mode): Promise<void> => {
    setDriveMode(nextMode);
    setEstopLatched(false);
    pressedKeysRef.current.clear();
    driveActiveRef.current = false;
    await ensureControlConnected();
    await api.control.setMode(nextMode).catch(reportError);
  };

  const handleEstop = async (): Promise<void> => {
    pressedKeysRef.current.clear();
    driveActiveRef.current = false;
    setEstopLatched(true);
    setLastDriveCommand({ throttle: 0, steer: 0 });
    await ensureControlConnected();
    await api.control.estop().catch(reportError);
    await api.control.releaseDrive().catch(() => {});
  };

  const handleRunOrPause = async (): Promise<void> => {
    setErrorMessage('');
    try {
      if (!runInfo || runInfo.state === 'ended') {
        const nextWorld: WorldFile = { ...worldFile, seed };
        const started = await api.run.start({ world: nextWorld, seed, speed });
        setRunInfo(started);
      } else if (runInfo.state === 'running') {
        await api.run.pause();
      } else if (runInfo.state === 'paused') {
        await api.run.resume();
      }
    } catch (err) {
      setErrorMessage(parseIpcError(err).message);
    }
  };

  const handleStopRun = async (): Promise<void> => {
    setErrorMessage('');
    try {
      await api.run.stop();
    } catch (err) {
      setErrorMessage(parseIpcError(err).message);
    }
  };

  const handleStepRun = async (): Promise<void> => {
    setErrorMessage('');
    try {
      await api.run.step(1);
    } catch (err) {
      setErrorMessage(parseIpcError(err).message);
    }
  };

  const handleSpeedChange = async (nextSpeed: RunSpeed): Promise<void> => {
    setSpeed(nextSpeed);
    if (runInfo && runInfo.state !== 'ended') {
      try {
        await api.run.setSpeed(nextSpeed);
      } catch (err) {
        setErrorMessage(parseIpcError(err).message);
      }
    }
  };

  const handleSaveLayout = async (): Promise<void> => {
    setErrorMessage('');
    setStatusMessage('');
    const targetPath = normalizeLayoutPath(layoutPath);
    setLayoutPath(targetPath);
    try {
      let payload: WorldFile = { ...worldFile, seed };
      if (isPaused) {
        try {
          const live = await api.worldEdit.currentLayout();
          payload = {
            ...live,
            seed,
            obstacles: worldFile.obstacles.length > 0 ? worldFile.obstacles : live.obstacles,
          };
        } catch {
          // Use local worldFile when no active live layout in main
        }
      }
      try {
        await api.worldEdit.save(targetPath, payload);
      } catch (saveErr) {
        if (parseIpcError(saveErr).code === 'not-implemented') {
          await api.project.writeFile(targetPath, `${JSON.stringify(payload, null, 2)}\n`);
        } else {
          throw saveErr;
        }
      }
      setStatusMessage(`Saved ${targetPath}`);
      const layouts = await api.worldEdit
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
    const targetPath = normalizeLayoutPath(pathToLoad);
    try {
      let loaded: WorldFile;
      try {
        loaded = await api.worldEdit.load(targetPath);
      } catch (loadErr) {
        if (parseIpcError(loadErr).code === 'not-implemented') {
          const raw = await api.project.readFile(targetPath);
          loaded = World.parse(JSON.parse(raw));
        } else {
          throw loadErr;
        }
      }
      setWorldFile(loaded);
      setSeed(loaded.seed);
      setLayoutPath(targetPath);
      setSelectedObstacleId(null);
      await loadTrackById(loaded.trackId);
      setStatusMessage(`Loaded ${targetPath}`);
    } catch (err) {
      setErrorMessage(parseIpcError(err).message);
    }
  };

  const selectedObstacle = worldFile.obstacles.find((o) => o.id === selectedObstacleId) ?? null;

  const simTimeSeconds = (effectiveSnapshot.timeUs / 1_000_000).toFixed(3);
  const dockTabs = useMemo(() => createWorldDockTabs(api), [api]);

  return (
    <section
      ref={rootRef}
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
                  {s === 'unpaced' ? 'Unpaced' : `${s}×`}
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
                setWorldFile((prev) => ({ ...prev, seed: nextSeed }));
              }}
              style={{ width: 72, padding: '4px 6px' }}
            />
          </label>
        </div>

        {/* Sim readouts: time, laps, collisions */}
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
          <span data-testid="sim-time-display">
            <strong>Sim time:</strong> {simTimeSeconds} s
          </span>
          <span data-testid="lap-counter">
            <strong>Laps:</strong> {effectiveSnapshot.laps.count}
          </span>
          <span data-testid="collision-count">
            <strong>Collisions:</strong> {effectiveSnapshot.collisions.count}
            {effectiveSnapshot.collisions.last ? ` (${effectiveSnapshot.collisions.last})` : ''}
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
          flexWrap: 'wrap',
          alignItems: 'center',
          gap: 10,
          padding: '6px 14px',
          background: '#141d26',
          borderBottom: '1px solid #2b3947',
          fontSize: 12,
          flexShrink: 0,
        }}
      >
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <span>Track</span>
          <select
            aria-label="Track"
            disabled={!editable || isPaused}
            value={worldFile.trackId}
            onChange={(e) => {
              const nextTrackId = e.target.value;
              setWorldFile((prev) => ({ ...prev, trackId: nextTrackId }));
              void loadTrackById(nextTrackId);
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
          style={{ display: 'flex', alignItems: 'center', gap: 4 }}
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
          style={{ display: 'flex', alignItems: 'center', gap: 6 }}
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
          style={{ display: 'flex', alignItems: 'center', gap: 5 }}
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
          style={{ display: 'flex', alignItems: 'center', gap: 4, marginLeft: 'auto' }}
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
      <WorldScene
        sceneData={sceneData}
        cameraMode={cameraMode}
        orbitState={orbitState}
        onOrbitChange={setOrbitState}
        interpolator={interpolator}
        editable={editable}
        activeTool={activeTool}
        selectedObstacleId={selectedObstacleId}
        onSelectObstacle={setSelectedObstacleId}
        onPlaceObstacleAt={handlePlaceObstacleAt}
        onMoveObstacleTo={handleMoveObstacleTo}
        onRotateObstacleTo={handleRotateObstacleTo}
      />

      {/* Shared bottom dock: portal Network Console into App's BottomPanel if present, else render BottomPanel when standalone */}
      {outerDockTargets ? (
        <>
          {createPortal(
            <button
              type="button"
              role="tab"
              data-testid="bottom-tab-network-console"
              aria-selected={panelOpen && panel === 'network'}
              onClick={() => showPanel('network')}
            >
              Network Console
            </button>,
            outerDockTargets.tablist,
          )}
          {createPortal(
            <div hidden={panel !== 'network'} className="panel-page">
              <NetworkConsole api={api} visible={panelOpen && panel === 'network'} />
            </div>,
            outerDockTargets.content,
          )}
        </>
      ) : !isHostedInApp ? (
        <BottomPanel api={api} projectDir="/project" jump={() => {}} tabs={dockTabs} />
      ) : null}
    </section>
  );
}
