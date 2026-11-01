// @rcsim/schema: every data file the system reads or writes, the wiring
// rules, the car config header generator and the default parts catalog.

export {
  DimensionsMm,
  GpioNumber,
  I2cAddress,
  InstanceId,
  MountPointId,
  PartDefinitionId,
  PinName,
  SCHEMA_VERSION,
  SchemaVersion,
  Vec3Mm,
  macroName,
} from './common.ts';
export {
  BEHAVIOR_TEMPLATES,
  BatteryParams,
  Behavior,
  DistanceRaycastParams,
  EscMotorParams,
  ImuParams,
  RegulatorParams,
  ServoParams,
  ThrottleCurvePoint,
  VoltageDividerParams,
  dividerRatio,
  type BehaviorTemplate,
} from './behavior.ts';
export {
  ActuatorDefinition,
  ChassisDefinition,
  ControllerDefinition,
  Electrical,
  GpioDefinition,
  I2cInfo,
  MountPoint,
  PART_CATEGORIES,
  PartDefinition,
  PassiveDefinition,
  PinDefinition,
  PinKind,
  PinVoltage,
  PowerDefinition,
  SensorDefinition,
  electricalOf,
  findPin,
  type PartCategory,
} from './part-definition.ts';
export { Car, Part, PinTarget, Placement, carParts } from './car.ts';
export { GroundPointM, GroundPose, Obstacle, ObstacleType, World } from './world.ts';
export { Track } from './track.ts';
export {
  CatalogError,
  createCatalog,
  type Catalog,
  type CatalogEntry,
  type CatalogProblem,
} from './catalog.ts';
export { DEFAULT_CATALOG_ENTRIES, defaultCatalog } from './default-catalog.ts';
export { exampleCar } from './example-car.ts';
export { Issue, IssueRef, WiringRuleId } from './wiring/issue.ts';
export { canRun, checkWiring } from './wiring/rules.ts';
export { generateCarConfigHeader } from './car-config-header.ts';
export { JSON_SCHEMA_FILES, jsonSchemaText } from './json-schemas.ts';
