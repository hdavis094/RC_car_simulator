import { Canvas } from '@react-three/fiber';
import {
  carParts,
  type Car,
  type Catalog,
  type DimensionsMm,
  type MountPoint,
  type PartCategory,
  type Vec3Mm,
} from '@rcsim/schema';
import { Component, type ErrorInfo, type ReactNode } from 'react';

const MM_TO_M = 0.001;
const DEG_TO_RAD = Math.PI / 180;

export interface BeamConeData {
  readonly minRangeMm: number;
  readonly maxRangeMm: number;
  readonly beamAngleDeg: number;
  readonly coneLengthM: number;
  readonly coneRadiusM: number;
}

export interface PlacedPartPreview {
  readonly instanceId: string;
  readonly partId: string;
  readonly name: string;
  readonly category: PartCategory;
  readonly mount: string;
  readonly positionMm: Vec3Mm;
  readonly yawDeg: number;
  readonly pitchDeg: number;
  readonly dimensionsMm: DimensionsMm;
  readonly beam?: BeamConeData;
}

export interface PreviewSceneData {
  readonly chassis: {
    readonly instanceId: string;
    readonly partId: string;
    readonly name: string;
    readonly dimensionsMm: DimensionsMm;
    readonly mountPoints: readonly MountPoint[];
  } | null;
  readonly placedParts: readonly PlacedPartPreview[];
}

/** Computes the 3D preview geometry (chassis box, placed part boxes, and distance-sensor beam cones). */
export function buildPreviewSceneData(car: Car, catalog: Catalog): PreviewSceneData {
  const chassisDef = catalog.get(car.chassis.partId);
  const chassis =
    chassisDef?.category === 'chassis'
      ? {
          instanceId: car.chassis.instanceId,
          partId: chassisDef.id,
          name: chassisDef.name,
          dimensionsMm: chassisDef.dimensionsMm,
          mountPoints: chassisDef.mountPoints,
        }
      : null;

  const mountMap = new Map<string, MountPoint>();
  for (const mp of chassis?.mountPoints ?? []) {
    mountMap.set(mp.id, mp);
  }

  const placedParts: PlacedPartPreview[] = [];
  for (const part of carParts(car)) {
    if (!part.placement) continue;
    const def = catalog.get(part.partId);
    if (!def) continue;
    const mountPoint = mountMap.get(part.placement.mount);
    const basePos = mountPoint?.positionMm ?? { x: 0, y: 0, z: 0 };
    const offset = part.placement.offsetMm ?? { x: 0, y: 0, z: 0 };
    const positionMm: Vec3Mm = {
      x: basePos.x + offset.x,
      y: basePos.y + offset.y,
      z: basePos.z + offset.z,
    };
    const yawDeg = (mountPoint?.yawDeg ?? 0) + (part.placement.yawDeg ?? 0);
    const pitchDeg = (mountPoint?.pitchDeg ?? 0) + (part.placement.pitchDeg ?? 0);

    let beam: BeamConeData | undefined;
    if ('behavior' in def && def.behavior.template === 'distance-raycast') {
      const { minRangeMm, maxRangeMm, beamAngleDeg } = def.behavior.params;
      const coneLengthM = maxRangeMm * MM_TO_M;
      const halfAngleRad = Math.min(89, beamAngleDeg / 2) * DEG_TO_RAD;
      const coneRadiusM = coneLengthM * Math.tan(halfAngleRad);
      beam = {
        minRangeMm,
        maxRangeMm,
        beamAngleDeg,
        coneLengthM,
        coneRadiusM,
      };
    }

    placedParts.push({
      instanceId: part.instanceId,
      partId: def.id,
      name: def.name,
      category: def.category,
      mount: part.placement.mount,
      positionMm,
      yawDeg,
      pitchDeg,
      dimensionsMm: def.dimensionsMm,
      ...(beam ? { beam } : {}),
    });
  }

  return { chassis, placedParts };
}

/** Three.js / react-three-fiber scene graph for the car preview. */
export function CarPreviewScene({ scene }: { readonly scene: PreviewSceneData }): ReactNode {
  const chassis = scene.chassis;
  return (
    <group>
      <ambientLight intensity={0.7} />
      <directionalLight position={[1.2, 2.0, 1.5]} intensity={0.9} />
      <gridHelper args={[2.5, 25, '#94a3b8', '#cbd5e1']} />

      {chassis && (
        <mesh
          position={[0, (chassis.dimensionsMm.height * MM_TO_M) / 2, 0]}
          name={`chassis:${chassis.instanceId}`}
        >
          <boxGeometry
            args={[
              chassis.dimensionsMm.width * MM_TO_M,
              chassis.dimensionsMm.height * MM_TO_M,
              chassis.dimensionsMm.length * MM_TO_M,
            ]}
          />
          <meshStandardMaterial color="#64748b" transparent opacity={0.45} />
        </mesh>
      )}

      {scene.placedParts.map((part) => {
        const w = part.dimensionsMm.width * MM_TO_M;
        const h = part.dimensionsMm.height * MM_TO_M;
        const l = part.dimensionsMm.length * MM_TO_M;
        const color =
          part.category === 'sensor'
            ? '#0284c7'
            : part.category === 'actuator'
              ? '#d97706'
              : '#4f46e5';

        return (
          <group
            key={part.instanceId}
            name={`part:${part.instanceId}`}
            position={[
              part.positionMm.x * MM_TO_M,
              part.positionMm.y * MM_TO_M,
              part.positionMm.z * MM_TO_M,
            ]}
            rotation={[part.pitchDeg * DEG_TO_RAD, part.yawDeg * DEG_TO_RAD, 0, 'YXZ']}
          >
            <mesh>
              <boxGeometry args={[w, h, l]} />
              <meshStandardMaterial color={color} />
            </mesh>
            {part.beam && (
              <mesh
                name={`beam:${part.instanceId}`}
                position={[0, 0, -part.beam.coneLengthM / 2]}
                rotation={[Math.PI / 2, 0, 0]}
              >
                <coneGeometry args={[part.beam.coneRadiusM, part.beam.coneLengthM, 24, 1, true]} />
                <meshStandardMaterial color="#38bdf8" transparent opacity={0.3} side={2} />
              </mesh>
            )}
          </group>
        );
      })}
    </group>
  );
}

let cachedWebGLSupport: boolean | undefined;

function canUseWebGL(): boolean {
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
    // Fallback rendered when headless environment cannot initialize WebGL.
  }

  override render(): ReactNode {
    if (this.state.hasError) return this.props.fallback;
    return this.props.children;
  }
}

export function CarPreview3D({
  car,
  catalog,
}: {
  readonly car: Car;
  readonly catalog: Catalog;
}): ReactNode {
  const scene = buildPreviewSceneData(car, catalog);
  const webglAvailable = canUseWebGL();

  const summaryOverlay = (
    <div
      data-testid="car-preview-summary"
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
        fontSize: 11,
        color: '#334155',
        padding: 8,
        background: '#f8fafc',
        borderTop: '1px solid #e2e8f0',
      }}
    >
      {scene.chassis && (
        <div data-testid="preview-chassis-box">
          <strong>Chassis box:</strong> {scene.chassis.name} ({scene.chassis.dimensionsMm.width} ×{' '}
          {scene.chassis.dimensionsMm.height} × {scene.chassis.dimensionsMm.length} mm)
        </div>
      )}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {scene.placedParts.map((part) => (
          <span
            key={part.instanceId}
            data-testid={`preview-part-${part.instanceId}`}
            style={{
              padding: '2px 6px',
              background: '#e2e8f0',
              borderRadius: 4,
            }}
          >
            <code>{part.instanceId}</code> @ {part.mount} ({part.positionMm.x}, {part.positionMm.y},{' '}
            {part.positionMm.z} mm; yaw {part.yawDeg}°, pitch {part.pitchDeg}°)
            {part.beam && (
              <span data-testid={`preview-beam-${part.instanceId}`}>
                {' '}
                — beam cone: {part.beam.maxRangeMm} mm, {part.beam.beamAngleDeg}°
              </span>
            )}
          </span>
        ))}
      </div>
    </div>
  );

  return (
    <div
      data-testid="car-preview-3d"
      style={{
        border: '1px solid #cbd5e1',
        borderRadius: 6,
        overflow: 'hidden',
        background: '#0f172a',
      }}
    >
      <div style={{ height: 240, position: 'relative' }}>
        {webglAvailable ? (
          <CanvasErrorBoundary
            fallback={
              <div
                style={{
                  height: '100%',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: '#94a3b8',
                  fontSize: 12,
                }}
              >
                3D Preview (WebGL unavailable in this environment)
              </div>
            }
          >
            <Canvas frameloop="demand" camera={{ position: [0.65, 0.55, -0.75], fov: 45 }}>
              <CarPreviewScene scene={scene} />
            </Canvas>
          </CanvasErrorBoundary>
        ) : (
          <div
            style={{
              height: '100%',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: '#94a3b8',
              fontSize: 12,
            }}
          >
            3D Preview (Chassis &amp; Sensor Beam Scene)
          </div>
        )}
      </div>
      {summaryOverlay}
    </div>
  );
}
