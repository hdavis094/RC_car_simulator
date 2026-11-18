export {
  WorldRoot,
  createWorldDockTabs,
  getWorldThreeScene,
  type WorldRootProps,
} from './WorldRoot.tsx';
export { NetworkConsole, formatIncomingLine, type RawConsoleEntry } from './NetworkConsole.tsx';
export { WorldScene, canUseWebGL, type EditorTool, type WorldSceneProps } from './WorldScene.tsx';
export {
  SnapshotInterpolator,
  interpolatePose,
  interpolateSnapshots,
  lerpNumber,
  lerpVec3,
  slerpQuat,
} from './interpolation.ts';
export {
  CAMERA_MODES,
  DEFAULT_CAR_GEOMETRY,
  DEFAULT_ORBIT_CAMERA,
  OBSTACLE_DIMENSIONS,
  buildWorldSceneData,
  computeCameraTransform,
  defaultSnapshotForWorld,
  groundPointToViewportUV,
  quatToYawDeg,
  rotateVec3ByQuat,
  screenToGroundPoint,
  syncThreeSceneGraph,
  yawDegToQuat,
  type CameraMode,
  type CameraTransform,
  type OrbitCameraState,
  type RenderedBeamData,
  type RenderedObstacleData,
  type RenderedWheelData,
  type WorldSceneData,
} from './scene-data.ts';
export {
  BUILTIN_OVAL_TRACK,
  BUILTIN_TECHNICAL_TRACK,
  BUILTIN_TRACKS,
  buildTrackSurfaceGeometry,
  generateTrackMeshData,
  offsetTrackLoop,
  sampleTrackCentreline,
  trackLeftOf,
  trackTangentAt,
  type GeneratedTrackMeshData,
  type SampledTrackCentreline,
  type StartFinishLineData,
  type TrackWallSegment,
} from './track-mesh.ts';
export {
  DRIVE_COMMAND_HZ,
  DRIVE_INTERVAL_MS,
  computeDriveFromGamepad,
  computeDriveFromKeys,
  isEditableEventTarget,
  isEstopKey,
  normalizeDriveKey,
  sampleManualDriveInput,
  type DriveCommandInput,
} from './driving-controller.ts';
