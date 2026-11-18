import { Canvas, useFrame, useThree } from '@react-three/fiber';
import type { ObstacleType } from '@rcsim/schema';
import {
  Component,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ErrorInfo,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type WheelEvent as ReactWheelEvent,
} from 'react';
import * as THREE from 'three';
import type { SnapshotInterpolator } from './interpolation.ts';
import {
  DEFAULT_CAR_GEOMETRY,
  OBSTACLE_DIMENSIONS,
  computeCameraTransform,
  extractRenderedBeams,
  groundPointToViewportUV,
  screenToGroundPoint,
  type CameraMode,
  type OrbitCameraState,
  type RenderedBeamData,
  type RenderedObstacleData,
  type WorldSceneData,
} from './scene-data.ts';
import { buildTrackSurfaceGeometry } from './track-mesh.ts';

let cachedWebGLSupport: boolean | undefined;

export function canUseWebGL(): boolean {
  if (cachedWebGLSupport !== undefined) return cachedWebGLSupport;
  if (typeof document === 'undefined' || typeof window === 'undefined') {
    cachedWebGLSupport = false;
    return false;
  }
  if (typeof ResizeObserver === 'undefined') {
    cachedWebGLSupport = false;
    return false;
  }
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
    if (!gl) {
      cachedWebGLSupport = false;
      return false;
    }
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    cachedWebGLSupport = true;
    return true;
  } catch {
    cachedWebGLSupport = false;
    return false;
  }
}

class CanvasErrorBoundary extends Component<
  { readonly children: ReactNode; readonly fallback: ReactNode },
  { readonly hasError: boolean }
> {
  constructor(props: { readonly children: ReactNode; readonly fallback: ReactNode }) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(): { hasError: boolean } {
    return { hasError: true };
  }

  override componentDidCatch(_error: Error, _info: ErrorInfo): void {
    // Fallback rendered when environment cannot initialize WebGL.
  }

  override render(): ReactNode {
    if (this.state.hasError) return this.props.fallback;
    return this.props.children;
  }
}

function buildRampGeometry(): THREE.BufferGeometry {
  const { halfWidth: w, halfLength: l, height: h } = OBSTACLE_DIMENSIONS.ramp;
  // Wedge rising from y=0 at +l to y=h at -l
  const positions = new Float32Array([
    // Bottom face
    -w,
    0,
    l,
    w,
    0,
    l,
    w,
    0,
    -l,
    -w,
    0,
    l,
    w,
    0,
    -l,
    -w,
    0,
    -l,
    // Sloped top face
    -w,
    0,
    l,
    w,
    h,
    -l,
    w,
    0,
    l,
    -w,
    0,
    l,
    -w,
    h,
    -l,
    w,
    h,
    -l,
    // Front vertical face (-Z)
    -w,
    0,
    -l,
    w,
    0,
    -l,
    w,
    h,
    -l,
    -w,
    0,
    -l,
    w,
    h,
    -l,
    -w,
    h,
    -l,
    // Left side (-X)
    -w,
    0,
    l,
    -w,
    0,
    -l,
    -w,
    h,
    -l,
    // Right side (+X)
    w,
    0,
    l,
    w,
    h,
    -l,
    w,
    0,
    -l,
  ]);
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geom.computeVertexNormals();
  return geom;
}

const SHARED_RAMP_GEOMETRY = buildRampGeometry();

function ObstacleMesh({
  obstacle,
  groupRef,
}: {
  readonly obstacle: RenderedObstacleData;
  readonly groupRef?: (el: THREE.Group | null) => void;
}): ReactNode {
  const { position, rotation } = obstacle.pose;

  return (
    <group
      ref={groupRef}
      name={`obstacle:${obstacle.id}`}
      position={[position[0], position[1], position[2]]}
      quaternion={[rotation[0], rotation[1], rotation[2], rotation[3]]}
    >
      {obstacle.type === 'cone' && (
        <group>
          {/* Traffic cone base */}
          <mesh position={[0, 0.01, 0]}>
            <boxGeometry args={[0.16, 0.02, 0.16]} />
            <meshStandardMaterial color="#ea580c" roughness={0.5} />
          </mesh>
          {/* Main cone body */}
          <mesh position={[0, OBSTACLE_DIMENSIONS.cone.height / 2, 0]}>
            <coneGeometry
              args={[OBSTACLE_DIMENSIONS.cone.radius * 1.15, OBSTACLE_DIMENSIONS.cone.height, 20]}
            />
            <meshStandardMaterial color="#f97316" roughness={0.4} />
          </mesh>
          {/* Reflective white collar */}
          <mesh position={[0, OBSTACLE_DIMENSIONS.cone.height * 0.58, 0]}>
            <cylinderGeometry
              args={[
                OBSTACLE_DIMENSIONS.cone.radius * 0.42,
                OBSTACLE_DIMENSIONS.cone.radius * 0.62,
                0.045,
                20,
              ]}
            />
            <meshStandardMaterial color="#f8fafc" roughness={0.3} />
          </mesh>
        </group>
      )}

      {obstacle.type === 'box' && (
        <mesh position={[0, OBSTACLE_DIMENSIONS.box.half, 0]}>
          <boxGeometry
            args={[
              OBSTACLE_DIMENSIONS.box.half * 2,
              OBSTACLE_DIMENSIONS.box.half * 2,
              OBSTACLE_DIMENSIONS.box.half * 2,
            ]}
          />
          <meshStandardMaterial color="#eab308" roughness={0.5} />
        </mesh>
      )}

      {obstacle.type === 'wall' && (
        <mesh position={[0, OBSTACLE_DIMENSIONS.wall.halfHeight, 0]}>
          <boxGeometry
            args={[
              OBSTACLE_DIMENSIONS.wall.halfLength * 2,
              OBSTACLE_DIMENSIONS.wall.halfHeight * 2,
              OBSTACLE_DIMENSIONS.wall.halfThickness * 2,
            ]}
          />
          <meshStandardMaterial color="#94a3b8" roughness={0.5} />
        </mesh>
      )}

      {obstacle.type === 'ramp' && (
        <mesh geometry={SHARED_RAMP_GEOMETRY}>
          <meshStandardMaterial color="#06b6d4" roughness={0.5} side={THREE.DoubleSide} />
        </mesh>
      )}

      {obstacle.selected && (
        <group name={`obstacle-selection:${obstacle.id}`}>
          <mesh position={[0, 0.008, 0]} rotation={[-Math.PI / 2, 0, 0]}>
            <ringGeometry args={[0.18, 0.23, 28]} />
            <meshBasicMaterial color="#84ddbf" side={THREE.DoubleSide} />
          </mesh>
          {/* Forward rotation handle along -Z */}
          <mesh position={[0, 0.02, -0.32]}>
            <sphereGeometry args={[0.04, 14, 14]} />
            <meshBasicMaterial color="#84ddbf" />
          </mesh>
        </group>
      )}
    </group>
  );
}

interface PooledBeamSlot {
  readonly group: THREE.Group;
  readonly line: THREE.Line;
  readonly lineGeometry: THREE.BufferGeometry;
  readonly positionAttr: THREE.BufferAttribute;
  readonly lineMaterial: THREE.LineBasicMaterial;
  readonly hitMesh: THREE.Mesh;
}

class SensorBeamsPool {
  readonly root = new THREE.Group();
  readonly #slots = new Map<string, PooledBeamSlot>();
  readonly #hitGeometry = new THREE.SphereGeometry(0.04, 14, 14);
  readonly #hitMaterial = new THREE.MeshBasicMaterial({ color: '#ef4444' });

  constructor() {
    this.root.name = 'sensor-beams-group';
  }

  sync(beams: readonly RenderedBeamData[]): void {
    const activeKeys = new Set<string>();

    for (const beam of beams) {
      activeKeys.add(beam.key);
      let slot = this.#slots.get(beam.key);
      if (!slot) {
        const positions = new Float32Array(6);
        const positionAttr = new THREE.BufferAttribute(positions, 3);
        const lineGeometry = new THREE.BufferGeometry();
        lineGeometry.setAttribute('position', positionAttr);
        const lineMaterial = new THREE.LineBasicMaterial({
          color: beam.hitPoint ? '#f97316' : '#38bdf8',
        });
        const line = new THREE.Line(lineGeometry, lineMaterial);
        line.name = `sensor-beam:${beam.key}`;

        const hitMesh = new THREE.Mesh(this.#hitGeometry, this.#hitMaterial);
        hitMesh.name = `beam-hit:${beam.key}`;

        const group = new THREE.Group();
        group.name = `sensor-beam-group:${beam.key}`;
        group.add(line);
        group.add(hitMesh);
        this.root.add(group);

        slot = {
          group,
          line,
          lineGeometry,
          positionAttr,
          lineMaterial,
          hitMesh,
        };
        this.#slots.set(beam.key, slot);
      }

      // Update endpoints in-place without allocating new BufferGeometry
      slot.positionAttr.setXYZ(0, beam.origin[0], beam.origin[1], beam.origin[2]);
      slot.positionAttr.setXYZ(1, beam.endPoint[0], beam.endPoint[1], beam.endPoint[2]);
      slot.positionAttr.needsUpdate = true;
      slot.lineMaterial.color.set(beam.hitPoint ? '#f97316' : '#38bdf8');

      if (beam.hitPoint) {
        slot.hitMesh.visible = true;
        slot.hitMesh.position.set(beam.hitPoint[0], beam.hitPoint[1], beam.hitPoint[2]);
      } else {
        slot.hitMesh.visible = false;
      }
    }

    for (const [key, slot] of this.#slots) {
      if (!activeKeys.has(key)) {
        this.root.remove(slot.group);
        slot.lineGeometry.dispose();
        slot.lineMaterial.dispose();
        this.#slots.delete(key);
      }
    }
  }

  dispose(): void {
    for (const [, slot] of this.#slots) {
      this.root.remove(slot.group);
      slot.lineGeometry.dispose();
      slot.lineMaterial.dispose();
    }
    this.#slots.clear();
    this.#hitGeometry.dispose();
    this.#hitMaterial.dispose();
  }
}

export interface WorldR3FSceneProps {
  readonly sceneData: WorldSceneData;
  readonly cameraMode: CameraMode;
  readonly orbitState: OrbitCameraState;
  readonly interpolator: SnapshotInterpolator;
  readonly onCameraReady?: (camera: THREE.Camera) => void;
}

export function WorldR3FScene({
  sceneData,
  cameraMode,
  orbitState,
  interpolator,
  onCameraReady,
}: WorldR3FSceneProps): ReactNode {
  const { camera } = useThree();
  const carGroupRef = useRef<THREE.Group>(null);
  const wheelGroupRefs = useRef<(THREE.Group | null)[]>([null, null, null, null]);
  const obstacleGroupRefs = useRef<Map<string, THREE.Group>>(new Map());
  const beamsPool = useMemo(() => new SensorBeamsPool(), []);

  useEffect(() => {
    onCameraReady?.(camera);
  }, [camera, onCameraReady]);

  useEffect(() => {
    return () => {
      beamsPool.dispose();
    };
  }, [beamsPool]);

  const surfaceGeometry = useMemo(
    () => buildTrackSurfaceGeometry(sceneData.trackMesh),
    [sceneData.trackMesh],
  );

  useEffect(() => {
    return () => {
      surfaceGeometry.dispose();
    };
  }, [surfaceGeometry]);

  const centreLineObject = useMemo(() => {
    const pts = sceneData.trackMesh.centrePoints.map((p) => new THREE.Vector3(p.x, 0.006, p.z));
    if (pts.length > 0 && pts[0]) pts.push(pts[0].clone());
    const geom = new THREE.BufferGeometry().setFromPoints(pts);
    const mat = new THREE.LineBasicMaterial({ color: '#64748b' });
    const line = new THREE.Line(geom, mat);
    line.name = 'track-centreline';
    return line;
  }, [sceneData.trackMesh]);

  const leftBorderObject = useMemo(() => {
    const pts = sceneData.trackMesh.leftEdgePoints.map((p) => new THREE.Vector3(p.x, 0.007, p.z));
    if (pts.length > 0 && pts[0]) pts.push(pts[0].clone());
    const geom = new THREE.BufferGeometry().setFromPoints(pts);
    const mat = new THREE.LineBasicMaterial({ color: '#cbd5e1' });
    const line = new THREE.Line(geom, mat);
    line.name = 'track-left-border';
    return line;
  }, [sceneData.trackMesh]);

  const rightBorderObject = useMemo(() => {
    const pts = sceneData.trackMesh.rightEdgePoints.map((p) => new THREE.Vector3(p.x, 0.007, p.z));
    if (pts.length > 0 && pts[0]) pts.push(pts[0].clone());
    const geom = new THREE.BufferGeometry().setFromPoints(pts);
    const mat = new THREE.LineBasicMaterial({ color: '#cbd5e1' });
    const line = new THREE.Line(geom, mat);
    line.name = 'track-right-border';
    return line;
  }, [sceneData.trackMesh]);

  useEffect(() => {
    return () => {
      centreLineObject.geometry.dispose();
      (centreLineObject.material as THREE.Material).dispose();
      leftBorderObject.geometry.dispose();
      (leftBorderObject.material as THREE.Material).dispose();
      rightBorderObject.geometry.dispose();
      (rightBorderObject.material as THREE.Material).dispose();
    };
  }, [centreLineObject, leftBorderObject, rightBorderObject]);

  const applySampledSnapshot = (sampled = interpolator.sample(performance.now())): void => {
    const activePose = sampled ? sampled.car.pose : sceneData.carPose;
    if (carGroupRef.current) {
      carGroupRef.current.position.set(...activePose.position);
      carGroupRef.current.quaternion.set(...activePose.rotation);
    }
    if (sampled) {
      sampled.car.wheels.forEach((w, idx) => {
        const ref = wheelGroupRefs.current[idx];
        if (ref) {
          ref.position.set(...w.position);
          ref.quaternion.set(...w.rotation);
        }
      });
      for (const obs of sampled.obstacles) {
        const obsGroup = obstacleGroupRefs.current.get(obs.id);
        if (obsGroup) {
          obsGroup.position.set(...obs.pose.position);
          obsGroup.quaternion.set(...obs.pose.rotation);
        }
      }
      beamsPool.sync(extractRenderedBeams(sampled));
    } else {
      beamsPool.sync(sceneData.sensorBeams);
    }

    const camTransform = computeCameraTransform(
      cameraMode,
      activePose,
      sceneData.trackMesh,
      orbitState,
    );
    camera.position.set(...camTransform.position);
    camera.up.set(...camTransform.up);
    camera.lookAt(...camTransform.target);
    camera.updateMatrixWorld();
  };

  useEffect(() => {
    applySampledSnapshot();
  });

  // 60 Hz render loop: interpolate between the last two snapshots and update car, wheels, obstacles, beams, and camera in place
  useFrame(() => {
    applySampledSnapshot(interpolator.sample(performance.now()));
  });

  const { bodyWidthM, bodyHeightM, bodyLengthM, bodyClearanceM, wheelRadiusM, wheelWidthM } =
    DEFAULT_CAR_GEOMETRY;
  const boxHeight = Math.max(bodyHeightM - bodyClearanceM, 0.01);
  const sf = sceneData.trackMesh.startFinish;

  return (
    <group name="world-r3f-root">
      <ambientLight intensity={0.9} />
      <directionalLight position={[6, 14, 8]} intensity={1.2} />
      <directionalLight position={[-6, 10, -8]} intensity={0.5} />

      {/* Ground plane */}
      <mesh name="ground-plane" rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, 0]}>
        <planeGeometry args={[60, 60]} />
        <meshStandardMaterial color="#0f1722" roughness={0.95} />
      </mesh>
      <gridHelper args={[30, 30, '#233243', '#16212d']} position={[0, 0.001, 0]} />

      {/* Track surface */}
      <mesh name="track-surface" geometry={surfaceGeometry}>
        <meshStandardMaterial color="#273545" roughness={0.8} side={THREE.DoubleSide} />
      </mesh>

      {/* Track borders and centreline */}
      <primitive object={centreLineObject} />
      <primitive object={leftBorderObject} />
      <primitive object={rightBorderObject} />

      {/* Track walls */}
      <group name="track-walls">
        {sceneData.trackMesh.walls.map((wall, idx) => (
          <mesh
            key={`${wall.edge}-${idx}`}
            name={`track-wall:${wall.edge}:${idx}`}
            position={[wall.position[0], wall.position[1], wall.position[2]]}
            rotation={[0, wall.yawRad, 0]}
          >
            <boxGeometry args={[wall.thicknessM, wall.heightM, wall.lengthM]} />
            <meshStandardMaterial color={idx % 2 === 0 ? '#94a3b8' : '#cbd5e1'} roughness={0.6} />
          </mesh>
        ))}
      </group>

      {/* Start/finish line */}
      <group
        name="track-start-finish"
        position={[sf.position[0], sf.position[1], sf.position[2]]}
        rotation={[0, sf.yawRad, 0]}
      >
        <mesh>
          <boxGeometry args={[sf.widthM, 0.005, sf.depthM]} />
          <meshStandardMaterial color="#f8fafc" />
        </mesh>
        {[-0.36, -0.12, 0.12, 0.36].map((offsetX) => (
          <mesh key={offsetX} position={[offsetX, 0.003, 0]}>
            <boxGeometry args={[sf.widthM * 0.12, 0.002, sf.depthM]} />
            <meshStandardMaterial color="#0f172a" />
          </mesh>
        ))}
      </group>

      {/* Car body posed from StateSnapshot */}
      <group
        ref={carGroupRef}
        name="car-body"
        position={[
          sceneData.carPose.position[0],
          sceneData.carPose.position[1],
          sceneData.carPose.position[2],
        ]}
        quaternion={[
          sceneData.carPose.rotation[0],
          sceneData.carPose.rotation[1],
          sceneData.carPose.rotation[2],
          sceneData.carPose.rotation[3],
        ]}
      >
        {/* Main chassis */}
        <mesh position={[0, bodyClearanceM + boxHeight * 0.38, 0]}>
          <boxGeometry args={[bodyWidthM, boxHeight * 0.72, bodyLengthM]} />
          <meshStandardMaterial color="#10b981" roughness={0.35} />
        </mesh>
        {/* Cabin canopy */}
        <mesh position={[0, bodyClearanceM + boxHeight * 0.82, 0.03]}>
          <boxGeometry args={[bodyWidthM * 0.78, boxHeight * 0.36, bodyLengthM * 0.48]} />
          <meshStandardMaterial color="#047857" roughness={0.3} />
        </mesh>
        {/* Front nose bar (-Z is forward) */}
        <mesh position={[0, bodyClearanceM + boxHeight * 0.28, -bodyLengthM * 0.49]}>
          <boxGeometry args={[bodyWidthM * 0.9, boxHeight * 0.25, 0.03]} />
          <meshStandardMaterial color="#a7f3d0" />
        </mesh>
      </group>

      {/* Four wheels posed directly in world frame from StateSnapshot */}
      {sceneData.wheels.map((wheel, index) => (
        <group
          key={wheel.name}
          ref={(el) => {
            wheelGroupRefs.current[index] = el;
          }}
          name={`wheel:${wheel.name}`}
          position={[wheel.position[0], wheel.position[1], wheel.position[2]]}
          quaternion={[wheel.rotation[0], wheel.rotation[1], wheel.rotation[2], wheel.rotation[3]]}
        >
          <mesh rotation={[0, 0, Math.PI / 2]}>
            <cylinderGeometry args={[wheelRadiusM, wheelRadiusM, wheelWidthM, 20]} />
            <meshStandardMaterial color="#111827" roughness={0.85} />
          </mesh>
          <mesh rotation={[0, 0, Math.PI / 2]}>
            <cylinderGeometry
              args={[wheelRadiusM * 0.55, wheelRadiusM * 0.55, wheelWidthM + 0.004, 12]}
            />
            <meshStandardMaterial color="#cbd5e1" roughness={0.4} />
          </mesh>
        </group>
      ))}

      {/* Obstacles */}
      {sceneData.obstacles.map((obs) => (
        <ObstacleMesh
          key={obs.id}
          obstacle={obs}
          groupRef={(el) => {
            if (el) {
              obstacleGroupRefs.current.set(obs.id, el);
            } else {
              obstacleGroupRefs.current.delete(obs.id);
            }
          }}
        />
      ))}

      {/* Pooled in-place sensor beams and hit markers */}
      <primitive object={beamsPool.root} />
    </group>
  );
}

export type EditorTool = 'select' | ObstacleType;

export interface WorldSceneProps {
  readonly sceneData: WorldSceneData;
  readonly cameraMode: CameraMode;
  readonly orbitState: OrbitCameraState;
  readonly onOrbitChange: (next: OrbitCameraState) => void;
  readonly interpolator: SnapshotInterpolator;
  readonly editable: boolean;
  readonly activeTool: EditorTool;
  readonly selectedObstacleId: string | null;
  readonly onSelectObstacle: (id: string | null) => void;
  readonly onPlaceObstacleAt: (point: { readonly x: number; readonly z: number }) => void;
  readonly onMoveObstacleTo: (
    id: string,
    point: { readonly x: number; readonly z: number },
    options?: { readonly dragging?: boolean },
  ) => void;
  readonly onRotateObstacleTo: (
    id: string,
    yawDeg: number,
    options?: { readonly dragging?: boolean },
  ) => void;
  readonly onObstacleDragEnd?: (id: string) => void;
}

export function WorldScene({
  sceneData,
  cameraMode,
  orbitState,
  onOrbitChange,
  interpolator,
  editable,
  activeTool,
  selectedObstacleId,
  onSelectObstacle,
  onPlaceObstacleAt,
  onMoveObstacleTo,
  onRotateObstacleTo,
  onObstacleDragEnd,
}: WorldSceneProps): ReactNode {
  const viewportRef = useRef<HTMLDivElement>(null);
  const liveCameraRef = useRef<THREE.Camera | null>(null);
  const [canvasReady, setCanvasReady] = useState(false);
  const [viewportSize, setViewportSize] = useState<{
    readonly width: number;
    readonly height: number;
  }>({ width: 800, height: 600 });
  const [dragState, setDragState] = useState<
    | { readonly kind: 'move-obstacle'; readonly id: string }
    | { readonly kind: 'rotate-obstacle'; readonly id: string }
    | {
        readonly kind: 'orbit';
        readonly startX: number;
        readonly startY: number;
        readonly initialOrbit: OrbitCameraState;
      }
    | null
  >(null);

  const webglAvailable = canUseWebGL();

  // Observe real viewport aspect ratio changes
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const updateSize = (): void => {
      const rect = el.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        setViewportSize((prev) =>
          Math.abs(prev.width - rect.width) < 0.5 && Math.abs(prev.height - rect.height) < 0.5
            ? prev
            : { width: rect.width, height: rect.height },
        );
      }
    };
    updateSize();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => updateSize());
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const cameraTransform = useMemo(() => {
    const sampled = interpolator.latest();
    const activePose = sampled ? sampled.car.pose : sceneData.carPose;
    return computeCameraTransform(cameraMode, activePose, sceneData.trackMesh, orbitState);
  }, [cameraMode, interpolator, orbitState, sceneData.carPose, sceneData.trackMesh]);

  const getViewportRect = (): {
    readonly left: number;
    readonly top: number;
    readonly width: number;
    readonly height: number;
  } => {
    const el = viewportRef.current;
    const rawRect = el?.getBoundingClientRect();
    if (rawRect && rawRect.width > 0 && rawRect.height > 0) {
      return rawRect;
    }
    return { left: 0, top: 0, width: viewportSize.width, height: viewportSize.height };
  };

  const getGroundPointFromEvent = (
    clientX: number,
    clientY: number,
  ): { readonly x: number; readonly z: number } | null => {
    const rect = getViewportRect();
    return screenToGroundPoint(clientX, clientY, rect, cameraTransform, 48, liveCameraRef.current);
  };

  const capturePointer = (target: Element, pointerId: number): void => {
    try {
      if (typeof target.setPointerCapture === 'function') {
        target.setPointerCapture(pointerId);
      }
    } catch {
      // Synthetic pointer events in unit tests may not have an active pointerId
    }
  };

  const releasePointer = (target: Element, pointerId: number): void => {
    try {
      if (
        typeof target.hasPointerCapture === 'function' &&
        target.hasPointerCapture(pointerId) &&
        typeof target.releasePointerCapture === 'function'
      ) {
        target.releasePointerCapture(pointerId);
      }
    } catch {
      // Ignore synthetic pointer event errors
    }
  };

  const finishDrag = (target?: Element | null, pointerId?: number): void => {
    if (target && pointerId !== undefined) {
      releasePointer(target, pointerId);
    }
    if (dragState && (dragState.kind === 'move-obstacle' || dragState.kind === 'rotate-obstacle')) {
      onObstacleDragEnd?.(dragState.id);
    }
    setDragState(null);
  };

  const handleGroundPointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0 && event.button !== undefined) return;
    const point = getGroundPointFromEvent(event.clientX, event.clientY);

    if (editable && activeTool !== 'select') {
      if (point) {
        onPlaceObstacleAt(point);
      }
      return;
    }

    // Check if pointer is close to an existing obstacle in world coordinates
    if (point) {
      let nearestId: string | null = null;
      let nearestDist = 0.35;
      for (const obs of sceneData.obstacles) {
        const d = Math.hypot(obs.pose.position[0] - point.x, obs.pose.position[2] - point.z);
        if (d < nearestDist) {
          nearestDist = d;
          nearestId = obs.id;
        }
      }
      if (nearestId) {
        onSelectObstacle(nearestId);
        if (editable) {
          capturePointer(event.currentTarget, event.pointerId);
          setDragState({ kind: 'move-obstacle', id: nearestId });
        }
        return;
      }
    }

    onSelectObstacle(null);
    if (cameraMode === 'orbit') {
      capturePointer(event.currentTarget, event.pointerId);
      setDragState({
        kind: 'orbit',
        startX: event.clientX,
        startY: event.clientY,
        initialOrbit: orbitState,
      });
    }
  };

  const handleGroundPointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (!dragState) return;
    if (dragState.kind === 'orbit') {
      const dx = event.clientX - dragState.startX;
      const dy = event.clientY - dragState.startY;
      onOrbitChange({
        ...dragState.initialOrbit,
        azimuthRad: dragState.initialOrbit.azimuthRad - dx * 0.008,
        elevationRad: Math.max(
          0.18,
          Math.min(Math.PI / 2 - 0.05, dragState.initialOrbit.elevationRad + dy * 0.008),
        ),
      });
      return;
    }

    if (!editable) return;
    const point = getGroundPointFromEvent(event.clientX, event.clientY);
    if (!point) return;

    if (dragState.kind === 'move-obstacle') {
      onMoveObstacleTo(dragState.id, point, { dragging: true });
    } else if (dragState.kind === 'rotate-obstacle') {
      const obs = sceneData.obstacles.find((o) => o.id === dragState.id);
      if (!obs) return;
      const dx = point.x - obs.pose.position[0];
      const dz = point.z - obs.pose.position[2];
      // Yaw 0 faces -Z; positive yaw turns left (-X)
      const yawDeg = Math.round(((Math.atan2(-dx, -dz) * 180) / Math.PI) * 10) / 10;
      onRotateObstacleTo(dragState.id, yawDeg, { dragging: true });
    }
  };

  const handleGroundPointerUp = (event: ReactPointerEvent<HTMLDivElement>): void => {
    finishDrag(event.currentTarget, event.pointerId);
  };

  const handleWheel = (event: ReactWheelEvent<HTMLDivElement>): void => {
    if (cameraMode !== 'orbit') return;
    const nextDist = Math.max(2.5, Math.min(30, orbitState.distanceM + event.deltaY * 0.01));
    onOrbitChange({ ...orbitState, distanceM: nextDist });
  };

  const nonWebglFallback = (
    <div
      data-testid="webgl-unavailable"
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: '#0f1722',
        color: '#9dafbe',
        fontSize: 13,
      }}
    >
      WebGL unavailable
    </div>
  );

  const liveAspect =
    viewportSize.width > 0 && viewportSize.height > 0
      ? viewportSize.width / viewportSize.height
      : 4 / 3;

  return (
    <div
      ref={viewportRef}
      data-testid="world-viewport"
      data-ready={webglAvailable ? (canvasReady ? 'true' : 'false') : 'true'}
      style={{
        position: 'relative',
        flex: 1,
        minHeight: 280,
        height: '100%',
        background: '#0f1722',
        overflow: 'hidden',
        userSelect: 'none',
      }}
    >
      <div style={{ position: 'absolute', inset: 0 }}>
        {webglAvailable ? (
          <CanvasErrorBoundary fallback={nonWebglFallback}>
            <Canvas
              gl={{ preserveDrawingBuffer: true, antialias: true }}
              camera={{ position: [...cameraTransform.position], fov: 48, near: 0.05, far: 500 }}
              onCreated={({ camera }) => {
                liveCameraRef.current = camera;
                setCanvasReady(true);
              }}
            >
              <WorldR3FScene
                sceneData={sceneData}
                cameraMode={cameraMode}
                orbitState={orbitState}
                interpolator={interpolator}
                onCameraReady={(cam) => {
                  liveCameraRef.current = cam;
                }}
              />
            </Canvas>
          </CanvasErrorBoundary>
        ) : (
          nonWebglFallback
        )}
      </div>

      {/* Interactive ground & obstacle manipulation surface */}
      <div
        data-testid="world-ground"
        aria-label="World ground"
        onPointerDown={handleGroundPointerDown}
        onPointerMove={handleGroundPointerMove}
        onPointerUp={handleGroundPointerUp}
        onPointerCancel={handleGroundPointerUp}
        onLostPointerCapture={() => finishDrag()}
        onWheel={handleWheel}
        style={{
          position: 'absolute',
          inset: 0,
          cursor:
            editable && activeTool !== 'select' ? 'crosshair' : dragState ? 'grabbing' : 'grab',
        }}
      >
        {/* Interactive obstacle handles for selection, dragging, and rotating */}
        {sceneData.obstacles.map((obs) => {
          const uv = groundPointToViewportUV(
            { x: obs.pose.position[0], z: obs.pose.position[2] },
            liveAspect,
            cameraTransform,
            48,
          );
          const isSelected = obs.id === selectedObstacleId;
          return (
            <div
              key={obs.id}
              data-testid={`obstacle-marker-${obs.id}`}
              data-obstacle-id={obs.id}
              data-obstacle-type={obs.type}
              data-position-x={obs.pose.position[0]}
              data-position-z={obs.pose.position[2]}
              data-yaw-deg={obs.yawDeg}
              onPointerDown={(e) => {
                e.stopPropagation();
                onSelectObstacle(obs.id);
                if (editable) {
                  if (viewportRef.current) {
                    const groundEl = viewportRef.current.querySelector(
                      '[data-testid="world-ground"]',
                    );
                    if (groundEl) capturePointer(groundEl, e.pointerId);
                  }
                  setDragState({ kind: 'move-obstacle', id: obs.id });
                }
              }}
              style={{
                position: 'absolute',
                left: `${Math.min(96, Math.max(4, uv.u * 100))}%`,
                top: `${Math.min(96, Math.max(4, uv.v * 100))}%`,
                transform: 'translate(-50%, -50%)',
                width: 24,
                height: 24,
                borderRadius: '50%',
                border: isSelected ? '2px solid #84ddbf' : '1px solid transparent',
                background: isSelected ? 'rgba(132, 221, 191, 0.18)' : 'transparent',
                cursor: editable ? 'move' : 'pointer',
              }}
              title={`${obs.type} (${obs.id}) @ (${obs.pose.position[0].toFixed(2)}, ${obs.pose.position[2].toFixed(2)}) m, ${obs.yawDeg.toFixed(1)}°`}
            >
              {isSelected && editable && (
                <button
                  type="button"
                  aria-label={`Rotate obstacle ${obs.id}`}
                  data-testid={`obstacle-rotate-handle-${obs.id}`}
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    if (viewportRef.current) {
                      const groundEl = viewportRef.current.querySelector(
                        '[data-testid="world-ground"]',
                      );
                      if (groundEl) capturePointer(groundEl, e.pointerId);
                    }
                    setDragState({ kind: 'rotate-obstacle', id: obs.id });
                  }}
                  onClick={(e) => {
                    e.stopPropagation();
                    onRotateObstacleTo(obs.id, ((obs.yawDeg + 15 + 180) % 360) - 180);
                  }}
                  style={{
                    position: 'absolute',
                    top: -22,
                    left: '50%',
                    transform: 'translateX(-50%)',
                    width: 18,
                    height: 18,
                    padding: 0,
                    borderRadius: '50%',
                    background: '#84ddbf',
                    color: '#0f172a',
                    border: '1px solid #0f172a',
                    fontSize: 10,
                    lineHeight: '16px',
                    textAlign: 'center',
                    cursor: 'grab',
                  }}
                  title="Drag or click to rotate obstacle"
                >
                  ↻
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
