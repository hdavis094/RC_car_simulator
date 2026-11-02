import {
  BEHAVIOR_TEMPLATES,
  Behavior,
  PART_CATEGORIES,
  PartDefinition,
  PinKind,
  SCHEMA_VERSION,
  type BehaviorTemplate,
  type GpioDefinition,
  type MountPoint,
  type PartCategory,
  type PinDefinition,
  type ThrottleCurvePoint,
} from '@rcsim/schema';
import { useState, type FormEvent, type ReactNode } from 'react';
import { NumericInput } from './NumericInput.tsx';
import { useWorkbenchStore } from './workbench-store.ts';

interface SchemaFieldDescriptor {
  readonly key: string;
  readonly kind: 'number' | 'boolean' | 'enum' | 'number-array' | 'throttle-curve';
  readonly description: string | undefined;
  readonly optional: boolean;
  readonly enumOptions?: readonly string[];
}

interface ZodLikeDef {
  readonly type?: string;
  readonly innerType?: ZodLikeSchema;
  readonly element?: ZodLikeSchema;
}

interface ZodLikeSchema {
  readonly def?: ZodLikeDef;
  readonly description?: string;
  readonly options?: readonly string[];
  readonly isOptional?: () => boolean;
}

/**
 * Introspects `@rcsim/schema`'s `Behavior` discriminated union to extract the
 * parameter fields for a given behavior template directly from the Zod schema.
 */
export function describeBehaviorParamsSchema(
  template: BehaviorTemplate,
): readonly SchemaFieldDescriptor[] {
  const option = Behavior.options.find((opt) => opt.shape.template.value === template);
  if (!option) return [];
  const shape = option.shape.params.shape as Record<string, ZodLikeSchema>;
  return Object.entries(shape).map(([key, fieldSchema]) => {
    const optional = fieldSchema.isOptional?.() ?? fieldSchema.def?.type === 'optional';
    const unwrapped: ZodLikeSchema =
      fieldSchema.def?.type === 'optional' && fieldSchema.def.innerType
        ? fieldSchema.def.innerType
        : fieldSchema;
    const rawType = unwrapped.def?.type;
    const description = fieldSchema.description ?? unwrapped.description;

    if (rawType === 'boolean') {
      return { key, kind: 'boolean', description, optional };
    }
    if (rawType === 'enum') {
      return {
        key,
        kind: 'enum',
        description,
        optional,
        enumOptions: unwrapped.options ?? [],
      };
    }
    if (rawType === 'array') {
      const elemType = unwrapped.def?.element?.def?.type;
      return {
        key,
        kind: elemType === 'number' ? 'number-array' : 'throttle-curve',
        description,
        optional,
      };
    }
    return { key, kind: 'number', description, optional };
  });
}

export function defaultBehaviorParams(template: BehaviorTemplate): Record<string, unknown> {
  switch (template) {
    case 'distance-raycast':
      return {
        minRangeMm: 20,
        maxRangeMm: 2000,
        beamAngleDeg: 20,
        rays: 5,
        noiseSigmaPct: 2,
        updateHz: 30,
      };
    case 'imu':
      return {
        accelRangesG: [2, 4, 8, 16],
        defaultAccelRangeG: 2,
        gyroRangesDps: [250, 500, 1000, 2000],
        defaultGyroRangeDps: 250,
        accelNoiseDensityUgPerSqrtHz: 400,
        gyroNoiseDensityDpsPerSqrtHz: 0.005,
        updateHz: 200,
      };
    case 'servo':
      return {
        travelDeg: 120,
        slewDegPerS: 300,
        pulseMinUs: 1000,
        pulseNeutralUs: 1500,
        pulseMaxUs: 2000,
        deadbandUs: 2,
        stallTorqueNm: 1.0,
      };
    case 'esc-motor':
      return {
        pulseMinUs: 1000,
        pulseNeutralUs: 1500,
        pulseMaxUs: 2000,
        deadbandUs: 30,
        armingMs: 2000,
        reverse: true,
        kvRpmPerV: 2500,
        maxTorqueNm: 0.2,
        throttleCurve: [
          { input: 0, output: 0 },
          { input: 1, output: 1 },
        ],
      };
    case 'battery':
      return {
        cells: 2,
        cellNominalV: 3.7,
        cellFullV: 4.2,
        cellEmptyV: 3.0,
        capacityMah: 5000,
        internalResistanceMohm: 12,
        maxContinuousC: 50,
      };
    case 'voltage-divider':
      return {
        r1Ohm: 10000,
        r2Ohm: 10000,
      };
    case 'regulator':
      return {
        topology: 'buck',
        outputV: 5,
        maxCurrentMa: 2000,
        efficiencyPct: 90,
      };
  }
}

export function defaultPinsForTemplate(template: BehaviorTemplate): PinDefinition[] {
  switch (template) {
    case 'distance-raycast':
      return [
        { name: 'VCC', kind: 'power-in' },
        { name: 'TRIG', kind: 'digital-in' },
        { name: 'ECHO', kind: 'digital-out', voltage: 3.3 },
        { name: 'GND', kind: 'gnd' },
      ];
    case 'imu':
      return [
        { name: 'VCC', kind: 'power-in' },
        { name: 'SDA', kind: 'i2c-sda', voltage: 3.3 },
        { name: 'SCL', kind: 'i2c-scl', voltage: 3.3 },
        { name: 'GND', kind: 'gnd' },
      ];
    case 'servo':
    case 'esc-motor':
      return [
        { name: 'V+', kind: 'power-in' },
        { name: 'SIGNAL', kind: 'pwm-in' },
        { name: 'GND', kind: 'gnd' },
      ];
    case 'battery':
      return [
        { name: 'BAT+', kind: 'power-out', voltage: { min: 6.0, max: 8.4 }, maxCurrentMa: 250000 },
        { name: 'BAT-', kind: 'gnd' },
      ];
    case 'voltage-divider':
      return [
        { name: 'IN', kind: 'analog-in' },
        { name: 'OUT', kind: 'analog-out' },
        { name: 'GND', kind: 'gnd' },
      ];
    case 'regulator':
      return [
        { name: 'VIN', kind: 'power-in' },
        { name: 'VOUT', kind: 'power-out', voltage: 5, maxCurrentMa: 2000 },
        { name: 'GND', kind: 'gnd' },
      ];
  }
}

type PinVoltageMode = 'none' | 'number' | 'supply' | 'range';

function getPinVoltageMode(voltage: PinDefinition['voltage']): PinVoltageMode {
  if (voltage === undefined) return 'none';
  if (voltage === 'supply') return 'supply';
  if (typeof voltage === 'number') return 'number';
  return 'range';
}

export function NewPartForm(): ReactNode {
  const newPartOpen = useWorkbenchStore((s) => s.newPartOpen);
  const setNewPartOpen = useWorkbenchStore((s) => s.setNewPartOpen);
  const createCustomPart = useWorkbenchStore((s) => s.createCustomPart);

  const [category, setCategory] = useState<PartCategory>('sensor');
  const [id, setId] = useState('sensor.custom-ranger');
  const [name, setName] = useState('Custom Ranger Sensor');
  const [manufacturer, setManufacturer] = useState('Custom');
  const [description, setDescription] = useState('Custom distance sensor');
  const [massG, setMassG] = useState(5);
  const [dimensionsMm, setDimensionsMm] = useState({ width: 20, height: 10, length: 15 });
  const [modelPath, setModelPath] = useState('');
  const [sourcesText, setSourcesText] = useState('https://example.com/datasheet.pdf');
  const [notes, setNotes] = useState('');

  // Electrical
  const [hasElectrical, setHasElectrical] = useState(true);
  const [supplyMinV, setSupplyMinV] = useState(3.0);
  const [supplyMaxV, setSupplyMaxV] = useState(5.5);
  const [logicLevelMode, setLogicLevelMode] = useState<'number' | 'supply'>('number');
  const [logicLevelV, setLogicLevelV] = useState(3.3);
  const [currentTypicalMa, setCurrentTypicalMa] = useState(15);
  const [currentPeakMa, setCurrentPeakMa] = useState(30);

  // I2C
  const [hasI2c, setHasI2c] = useState(false);
  const [i2cDefaultAddress, setI2cDefaultAddress] = useState(41);
  const [i2cAddressingKind, setI2cAddressingKind] = useState<'fixed' | 'strap' | 'software'>(
    'fixed',
  );
  const [i2cEnablePin, setI2cEnablePin] = useState('XSHUT');
  const [i2cStrapPin, setI2cStrapPin] = useState('AD0');
  const [i2cStrapHighAddress, setI2cStrapHighAddress] = useState(42);

  // Behavior
  const [template, setTemplate] = useState<BehaviorTemplate>('distance-raycast');
  const [behaviorParams, setBehaviorParams] = useState<Record<string, unknown>>(() =>
    defaultBehaviorParams('distance-raycast'),
  );

  // Pins
  const [pins, setPins] = useState<PinDefinition[]>(() =>
    defaultPinsForTemplate('distance-raycast'),
  );

  // Controller fields
  const [gpioMaxInputV, setGpioMaxInputV] = useState(3.6);
  const [gpios, setGpios] = useState<GpioDefinition[]>([
    { gpio: 0, strapping: true },
    { gpio: 21 },
    { gpio: 22 },
  ]);

  // Chassis fields
  const [wheelbaseMm, setWheelbaseMm] = useState(300);
  const [trackWidthMm, setTrackWidthMm] = useState(220);
  const [wheelRadiusMm, setWheelRadiusMm] = useState(50);
  const [maxSteeringAngleDeg, setMaxSteeringAngleDeg] = useState(28);
  const [steeringLinkageRatio, setSteeringLinkageRatio] = useState(0.7);
  const [driveWheels, setDriveWheels] = useState<'rear' | 'front' | 'all'>('rear');
  const [finalDriveRatio, setFinalDriveRatio] = useState(12);
  const [centreOfGravityMm, setCentreOfGravityMm] = useState({ x: 0, y: 80, z: 0 });
  const [mountPoints, setMountPoints] = useState<MountPoint[]>([
    { id: 'front-centre', positionMm: { x: 0, y: 50, z: -200 }, yawDeg: 0, pitchDeg: 0 },
  ]);

  const [validationErrors, setValidationErrors] = useState<readonly string[]>([]);
  const [submitting, setSubmitting] = useState(false);

  const resetForm = () => {
    setCategory('sensor');
    setId('sensor.custom-ranger');
    setName('Custom Ranger Sensor');
    setManufacturer('Custom');
    setDescription('Custom distance sensor');
    setMassG(5);
    setDimensionsMm({ width: 20, height: 10, length: 15 });
    setModelPath('');
    setSourcesText('https://example.com/datasheet.pdf');
    setNotes('');
    setHasElectrical(true);
    setSupplyMinV(3.0);
    setSupplyMaxV(5.5);
    setLogicLevelMode('number');
    setLogicLevelV(3.3);
    setCurrentTypicalMa(15);
    setCurrentPeakMa(30);
    setHasI2c(false);
    setI2cDefaultAddress(41);
    setI2cAddressingKind('fixed');
    setI2cEnablePin('XSHUT');
    setI2cStrapPin('AD0');
    setI2cStrapHighAddress(42);
    setTemplate('distance-raycast');
    setBehaviorParams(defaultBehaviorParams('distance-raycast'));
    setPins(defaultPinsForTemplate('distance-raycast'));
    setGpioMaxInputV(3.6);
    setGpios([{ gpio: 0, strapping: true }, { gpio: 21 }, { gpio: 22 }]);
    setWheelbaseMm(300);
    setTrackWidthMm(220);
    setWheelRadiusMm(50);
    setMaxSteeringAngleDeg(28);
    setSteeringLinkageRatio(0.7);
    setDriveWheels('rear');
    setFinalDriveRatio(12);
    setCentreOfGravityMm({ x: 0, y: 80, z: 0 });
    setMountPoints([
      { id: 'front-centre', positionMm: { x: 0, y: 50, z: -200 }, yawDeg: 0, pitchDeg: 0 },
    ]);
    setValidationErrors([]);
  };

  if (!newPartOpen) return null;

  const handleCategoryChange = (nextCategory: PartCategory) => {
    setCategory(nextCategory);
    if (nextCategory === 'sensor') {
      setTemplate('distance-raycast');
      setBehaviorParams(defaultBehaviorParams('distance-raycast'));
      setPins(defaultPinsForTemplate('distance-raycast'));
      setHasElectrical(true);
    } else if (nextCategory === 'actuator') {
      setTemplate('servo');
      setBehaviorParams(defaultBehaviorParams('servo'));
      setPins(defaultPinsForTemplate('servo'));
      setHasElectrical(true);
    } else if (nextCategory === 'power') {
      setTemplate('regulator');
      setBehaviorParams(defaultBehaviorParams('regulator'));
      setPins(defaultPinsForTemplate('regulator'));
      setHasElectrical(true);
    } else if (nextCategory === 'passive') {
      setTemplate('voltage-divider');
      setBehaviorParams(defaultBehaviorParams('voltage-divider'));
      setPins(defaultPinsForTemplate('voltage-divider'));
      setHasElectrical(false);
    } else if (nextCategory === 'controller') {
      setPins([
        { name: '5V', kind: 'power-in' },
        { name: '3V3', kind: 'power-out', voltage: 3.3, maxCurrentMa: 500 },
        { name: 'GND', kind: 'gnd' },
      ]);
      setHasElectrical(true);
    } else if (nextCategory === 'chassis') {
      setPins([]);
      setHasElectrical(false);
    }
  };

  const handleTemplateChange = (nextTemplate: BehaviorTemplate) => {
    setTemplate(nextTemplate);
    const defaults = defaultBehaviorParams(nextTemplate);
    setBehaviorParams(defaults);
    setPins(defaultPinsForTemplate(nextTemplate));
    if (nextTemplate === 'battery') {
      setHasElectrical(false);
    }
    if (nextTemplate === 'imu') {
      setHasI2c(true);
    }
  };

  const updateBehaviorParam = (key: string, value: unknown) => {
    const next = { ...behaviorParams, [key]: value };
    setBehaviorParams(next);

    // Keep regulator / battery power-out pin values aligned if present
    if (template === 'regulator') {
      const outputV = Number(next['outputV'] ?? 5);
      const maxCurrentMa = Number(next['maxCurrentMa'] ?? 2000);
      setPins((prev) =>
        prev.map((p) => (p.kind === 'power-out' ? { ...p, voltage: outputV, maxCurrentMa } : p)),
      );
    } else if (template === 'battery') {
      const cells = Number(next['cells'] ?? 2);
      const cellEmptyV = Number(next['cellEmptyV'] ?? 3.0);
      const cellFullV = Number(next['cellFullV'] ?? 4.2);
      const capacityMah = Number(next['capacityMah'] ?? 5000);
      const maxContinuousC = Number(next['maxContinuousC'] ?? 50);
      setPins((prev) =>
        prev.map((p) =>
          p.kind === 'power-out'
            ? {
                ...p,
                voltage: {
                  min: Number((cells * cellEmptyV).toFixed(6)),
                  max: Number((cells * cellFullV).toFixed(6)),
                },
                maxCurrentMa: Number((capacityMah * maxContinuousC).toFixed(6)),
              }
            : p,
        ),
      );
    }
  };

  const buildCandidatePart = (): unknown => {
    const sources = sourcesText
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);

    const base: Record<string, unknown> = {
      schemaVersion: SCHEMA_VERSION,
      id: id.trim(),
      name: name.trim(),
      ...(manufacturer.trim() ? { manufacturer: manufacturer.trim() } : {}),
      ...(description.trim() ? { description: description.trim() } : {}),
      massG,
      dimensionsMm,
      ...(modelPath.trim() ? { modelPath: modelPath.trim() } : {}),
      pins,
      sources,
      ...(notes.trim() ? { notes: notes.trim() } : {}),
      category,
    };

    const electrical = {
      supplyV: { min: supplyMinV, max: supplyMaxV },
      logicLevelV: logicLevelMode === 'supply' ? ('supply' as const) : logicLevelV,
      currentMa: { typical: currentTypicalMa, peak: currentPeakMa },
    };

    const i2c = hasI2c
      ? {
          defaultAddress: i2cDefaultAddress,
          addressing:
            i2cAddressingKind === 'fixed'
              ? { kind: 'fixed' as const }
              : i2cAddressingKind === 'software'
                ? { kind: 'software' as const, enablePin: i2cEnablePin }
                : {
                    kind: 'strap' as const,
                    pin: i2cStrapPin,
                    addresses: [i2cDefaultAddress, i2cStrapHighAddress],
                  },
        }
      : undefined;

    if (category === 'controller') {
      return {
        ...base,
        electrical,
        gpios,
        gpioMaxInputV,
      };
    }

    if (category === 'chassis') {
      return {
        ...base,
        wheelbaseMm,
        trackWidthMm,
        wheelRadiusMm,
        maxSteeringAngleDeg,
        steeringLinkageRatio,
        driveWheels,
        finalDriveRatio,
        centreOfGravityMm,
        mountPoints,
      };
    }

    if (category === 'passive') {
      return {
        ...base,
        behavior: {
          template,
          params: behaviorParams,
        },
      };
    }

    if (category === 'power') {
      return {
        ...base,
        ...(hasElectrical ? { electrical } : {}),
        behavior: {
          template,
          params: behaviorParams,
        },
      };
    }

    // sensor or actuator
    return {
      ...base,
      electrical,
      ...(i2c ? { i2c } : {}),
      behavior: {
        template,
        params: behaviorParams,
      },
    };
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const candidate = buildCandidatePart();
    const parsed = PartDefinition.safeParse(candidate);
    if (!parsed.success) {
      setValidationErrors(
        parsed.error.issues.map(
          (issue) => `${issue.path.length > 0 ? `${issue.path.join('.')}: ` : ''}${issue.message}`,
        ),
      );
      return;
    }

    setSubmitting(true);
    const result = await createCustomPart(parsed.data);
    setSubmitting(false);
    if (!result.ok) {
      setValidationErrors([result.error]);
    } else {
      resetForm();
    }
  };

  const updateGpio = (idx: number, updater: (prev: GpioDefinition) => GpioDefinition) => {
    setGpios((prev) => prev.map((item, i) => (i === idx ? updater(item) : item)));
  };

  const updatePin = (idx: number, updater: (prev: PinDefinition) => PinDefinition) => {
    setPins((prev) => prev.map((item, i) => (i === idx ? updater(item) : item)));
  };

  const schemaDescriptors = describeBehaviorParamsSchema(template);
  const supportsBehavior =
    category === 'sensor' ||
    category === 'actuator' ||
    category === 'power' ||
    category === 'passive';
  const supportsElectrical =
    category === 'controller' ||
    category === 'sensor' ||
    category === 'actuator' ||
    category === 'power';
  const supportsI2c = category === 'sensor' || category === 'actuator';

  return (
    <section
      aria-label="New Part form"
      data-testid="new-part-form"
      style={{
        border: '2px solid #2563eb',
        borderRadius: 6,
        padding: 16,
        background: '#ffffff',
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        fontSize: 12,
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h2 style={{ margin: 0, fontSize: 16 }}>New Part</h2>
        <button
          type="button"
          onClick={() => setNewPartOpen(false)}
          style={{
            fontSize: 12,
            padding: '4px 8px',
            border: '1px solid #cbd5e1',
            borderRadius: 4,
            background: '#f8fafc',
            cursor: 'pointer',
          }}
        >
          Cancel
        </button>
      </div>

      {validationErrors.length > 0 && (
        <div
          role="alert"
          data-testid="new-part-errors"
          style={{
            padding: 8,
            background: '#fef2f2',
            border: '1px solid #fca5a5',
            borderRadius: 4,
            color: '#b91c1c',
          }}
        >
          <strong>Validation errors:</strong>
          <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
            {validationErrors.map((err, idx) => (
              <li key={idx}>{err}</li>
            ))}
          </ul>
        </div>
      )}

      <form
        onSubmit={(e) => void handleSubmit(e)}
        style={{ display: 'flex', flexDirection: 'column', gap: 12 }}
      >
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
            gap: 8,
          }}
        >
          <label style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <span>Category</span>
            <select
              aria-label="Part category"
              value={category}
              onChange={(e) => handleCategoryChange(e.target.value as PartCategory)}
            >
              {PART_CATEGORIES.map((cat) => (
                <option key={cat} value={cat}>
                  {cat}
                </option>
              ))}
            </select>
          </label>

          <label style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <span>Part Definition ID</span>
            <input
              type="text"
              aria-label="Part definition id"
              value={id}
              onChange={(e) => setId(e.target.value)}
              placeholder="sensor.my-part"
            />
          </label>

          <label style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <span>Part Name</span>
            <input
              type="text"
              aria-label="Part name"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>

          <label style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <span>Manufacturer</span>
            <input
              type="text"
              aria-label="Part manufacturer"
              value={manufacturer}
              onChange={(e) => setManufacturer(e.target.value)}
            />
          </label>

          <label style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <span>Mass (g)</span>
            <NumericInput
              step="any"
              aria-label="Part mass (g)"
              value={massG}
              onChange={(n) => setMassG(n)}
            />
          </label>

          <label style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <span>Width (mm)</span>
            <NumericInput
              step="any"
              aria-label="Part width (mm)"
              value={dimensionsMm.width}
              onChange={(n) => setDimensionsMm({ ...dimensionsMm, width: n })}
            />
          </label>

          <label style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <span>Height (mm)</span>
            <NumericInput
              step="any"
              aria-label="Part height (mm)"
              value={dimensionsMm.height}
              onChange={(n) => setDimensionsMm({ ...dimensionsMm, height: n })}
            />
          </label>

          <label style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <span>Length (mm)</span>
            <NumericInput
              step="any"
              aria-label="Part length (mm)"
              value={dimensionsMm.length}
              onChange={(n) => setDimensionsMm({ ...dimensionsMm, length: n })}
            />
          </label>

          <label style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <span>Model Path (optional glTF)</span>
            <input
              type="text"
              aria-label="Part model path"
              value={modelPath}
              onChange={(e) => setModelPath(e.target.value)}
            />
          </label>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <span>Description</span>
            <input
              type="text"
              aria-label="Part description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </label>

          <label style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <span>Notes</span>
            <input
              type="text"
              aria-label="Part notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </label>
        </div>

        <label style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <span>Datasheet Sources (one URL per line)</span>
          <textarea
            aria-label="Datasheet sources"
            rows={2}
            value={sourcesText}
            onChange={(e) => setSourcesText(e.target.value)}
          />
        </label>

        {/* Electrical section */}
        {supportsElectrical && (
          <fieldset style={{ border: '1px solid #e2e8f0', borderRadius: 4, padding: 8 }}>
            <legend style={{ fontWeight: 600 }}>
              Electrical
              {category === 'power' && (
                <label style={{ marginLeft: 8, fontWeight: 400 }}>
                  <input
                    type="checkbox"
                    checked={hasElectrical}
                    onChange={(e) => setHasElectrical(e.target.checked)}
                  />{' '}
                  Has supply input
                </label>
              )}
            </legend>
            {(category !== 'power' || hasElectrical) && (
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
                  gap: 8,
                }}
              >
                <label style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <span>Supply Min (V)</span>
                  <NumericInput
                    step="any"
                    aria-label="Supply min V"
                    value={supplyMinV}
                    onChange={(n) => setSupplyMinV(n)}
                  />
                </label>
                <label style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <span>Supply Max (V)</span>
                  <NumericInput
                    step="any"
                    aria-label="Supply max V"
                    value={supplyMaxV}
                    onChange={(n) => setSupplyMaxV(n)}
                  />
                </label>
                <label style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <span>Logic Level Mode</span>
                  <select
                    aria-label="Logic level mode"
                    value={logicLevelMode}
                    onChange={(e) => setLogicLevelMode(e.target.value as 'number' | 'supply')}
                  >
                    <option value="number">Fixed voltage</option>
                    <option value="supply">Follows supply</option>
                  </select>
                </label>
                {logicLevelMode === 'number' && (
                  <label style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                    <span>Logic Level (V)</span>
                    <NumericInput
                      step="any"
                      aria-label="Logic level V"
                      value={logicLevelV}
                      onChange={(n) => setLogicLevelV(n)}
                    />
                  </label>
                )}
                <label style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <span>Typical Current (mA)</span>
                  <NumericInput
                    step="any"
                    aria-label="Typical current mA"
                    value={currentTypicalMa}
                    onChange={(n) => setCurrentTypicalMa(n)}
                  />
                </label>
                <label style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <span>Peak Current (mA)</span>
                  <NumericInput
                    step="any"
                    aria-label="Peak current mA"
                    value={currentPeakMa}
                    onChange={(n) => setCurrentPeakMa(n)}
                  />
                </label>
              </div>
            )}
          </fieldset>
        )}

        {/* I2C section */}
        {supportsI2c && (
          <fieldset style={{ border: '1px solid #e2e8f0', borderRadius: 4, padding: 8 }}>
            <legend style={{ fontWeight: 600 }}>
              <label>
                <input
                  type="checkbox"
                  aria-label="Has I2C interface"
                  checked={hasI2c}
                  onChange={(e) => setHasI2c(e.target.checked)}
                />{' '}
                I²C Interface
              </label>
            </legend>
            {hasI2c && (
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
                  gap: 8,
                }}
              >
                <label style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <span>Default Address (7-bit)</span>
                  <NumericInput
                    min={8}
                    max={119}
                    aria-label="I2C default address"
                    value={i2cDefaultAddress}
                    onChange={(n) => setI2cDefaultAddress(n)}
                  />
                </label>
                <label style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <span>Addressing Kind</span>
                  <select
                    aria-label="I2C addressing kind"
                    value={i2cAddressingKind}
                    onChange={(e) =>
                      setI2cAddressingKind(e.target.value as 'fixed' | 'strap' | 'software')
                    }
                  >
                    <option value="fixed">fixed</option>
                    <option value="strap">strap</option>
                    <option value="software">software</option>
                  </select>
                </label>
                {i2cAddressingKind === 'software' && (
                  <label style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                    <span>Enable Pin</span>
                    <input
                      type="text"
                      aria-label="I2C enable pin"
                      value={i2cEnablePin}
                      onChange={(e) => setI2cEnablePin(e.target.value)}
                    />
                  </label>
                )}
                {i2cAddressingKind === 'strap' && (
                  <>
                    <label style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                      <span>Strap Pin</span>
                      <input
                        type="text"
                        aria-label="I2C strap pin"
                        value={i2cStrapPin}
                        onChange={(e) => setI2cStrapPin(e.target.value)}
                      />
                    </label>
                    <label style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                      <span>High Address</span>
                      <NumericInput
                        min={8}
                        max={119}
                        aria-label="I2C strap high address"
                        value={i2cStrapHighAddress}
                        onChange={(n) => setI2cStrapHighAddress(n)}
                      />
                    </label>
                  </>
                )}
              </div>
            )}
          </fieldset>
        )}

        {/* Behavior template & schema-generated params form */}
        {supportsBehavior && (
          <fieldset
            data-testid="behavior-params-fieldset"
            style={{ border: '1px solid #e2e8f0', borderRadius: 4, padding: 8 }}
          >
            <legend style={{ fontWeight: 600 }}>Behavior Template &amp; Parameters</legend>
            <div style={{ marginBottom: 8 }}>
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                <span>Behavior Template:</span>
                <select
                  aria-label="Behavior template"
                  value={template}
                  onChange={(e) => handleTemplateChange(e.target.value as BehaviorTemplate)}
                >
                  {BEHAVIOR_TEMPLATES.map((tpl) => (
                    <option key={tpl} value={tpl}>
                      {tpl}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
                gap: 8,
              }}
            >
              {schemaDescriptors.map((field) => {
                const rawVal = behaviorParams[field.key];
                if (field.kind === 'boolean') {
                  return (
                    <label
                      key={field.key}
                      style={{ display: 'flex', alignItems: 'center', gap: 6 }}
                      title={field.description}
                    >
                      <input
                        type="checkbox"
                        aria-label={`Param ${field.key}`}
                        checked={Boolean(rawVal)}
                        onChange={(e) => updateBehaviorParam(field.key, e.target.checked)}
                      />
                      <span>{field.key}</span>
                    </label>
                  );
                }
                if (field.kind === 'enum') {
                  return (
                    <label
                      key={field.key}
                      style={{ display: 'flex', flexDirection: 'column', gap: 2 }}
                      title={field.description}
                    >
                      <span>{field.key}</span>
                      <select
                        aria-label={`Param ${field.key}`}
                        value={String(rawVal ?? field.enumOptions?.[0] ?? '')}
                        onChange={(e) => updateBehaviorParam(field.key, e.target.value)}
                      >
                        {(field.enumOptions ?? []).map((opt) => (
                          <option key={opt} value={opt}>
                            {opt}
                          </option>
                        ))}
                      </select>
                    </label>
                  );
                }
                if (field.kind === 'number-array') {
                  const listStr = Array.isArray(rawVal) ? rawVal.join(', ') : '';
                  return (
                    <label
                      key={field.key}
                      style={{ display: 'flex', flexDirection: 'column', gap: 2 }}
                      title={field.description}
                    >
                      <span>{field.key} (comma-separated)</span>
                      <input
                        type="text"
                        aria-label={`Param ${field.key}`}
                        value={listStr}
                        onChange={(e) => {
                          const nums = e.target.value
                            .split(',')
                            .map((s) => Number(s.trim()))
                            .filter((n) => !Number.isNaN(n));
                          updateBehaviorParam(field.key, nums);
                        }}
                      />
                    </label>
                  );
                }
                if (field.kind === 'throttle-curve') {
                  const points = (rawVal as ThrottleCurvePoint[] | undefined) ?? [
                    { input: 0, output: 0 },
                    { input: 1, output: 1 },
                  ];
                  const curveStr = points.map((p) => `${p.input}:${p.output}`).join(', ');
                  return (
                    <label
                      key={field.key}
                      style={{ display: 'flex', flexDirection: 'column', gap: 2 }}
                      title={field.description}
                    >
                      <span>{field.key} (input:output pairs)</span>
                      <input
                        type="text"
                        aria-label={`Param ${field.key}`}
                        value={curveStr}
                        onChange={(e) => {
                          const parsedPoints: ThrottleCurvePoint[] = e.target.value
                            .split(',')
                            .map((pair) => {
                              const [inp, out] = pair.split(':').map((s) => Number(s.trim()));
                              return { input: inp ?? 0, output: out ?? 0 };
                            });
                          updateBehaviorParam(field.key, parsedPoints);
                        }}
                      />
                    </label>
                  );
                }
                return (
                  <label
                    key={field.key}
                    style={{ display: 'flex', flexDirection: 'column', gap: 2 }}
                    title={field.description}
                  >
                    <span>
                      {field.key}
                      {field.optional ? ' (optional)' : ''}
                    </span>
                    <NumericInput
                      step="any"
                      aria-label={`Param ${field.key}`}
                      value={rawVal === undefined ? undefined : Number(rawVal)}
                      onChange={(n) => updateBehaviorParam(field.key, n)}
                      {...(field.optional
                        ? { onClear: () => updateBehaviorParam(field.key, undefined) }
                        : {})}
                    />
                  </label>
                );
              })}
            </div>
          </fieldset>
        )}

        {/* Controller-specific fields */}
        {category === 'controller' && (
          <fieldset style={{ border: '1px solid #e2e8f0', borderRadius: 4, padding: 8 }}>
            <legend style={{ fontWeight: 600 }}>Controller GPIOs</legend>
            <label
              style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginBottom: 8 }}
            >
              <span>Max GPIO Input Voltage (V):</span>
              <NumericInput
                step="any"
                aria-label="Max GPIO input V"
                value={gpioMaxInputV}
                onChange={(n) => setGpioMaxInputV(n)}
              />
            </label>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {gpios.map((g, idx) => (
                <div
                  key={idx}
                  data-testid={`controller-gpio-row-${idx}`}
                  style={{
                    display: 'flex',
                    flexWrap: 'wrap',
                    gap: 6,
                    alignItems: 'center',
                    padding: 4,
                    background: '#f8fafc',
                    borderRadius: 4,
                  }}
                >
                  <NumericInput
                    aria-label={`Controller GPIO number ${idx}`}
                    value={g.gpio}
                    onChange={(n) => updateGpio(idx, (prev) => ({ ...prev, gpio: n }))}
                    style={{ width: 60 }}
                  />
                  <input
                    type="text"
                    aria-label={`Controller GPIO label ${idx}`}
                    placeholder="Label"
                    value={g.label ?? ''}
                    onChange={(e) => {
                      const val = e.target.value;
                      updateGpio(idx, (prev) => {
                        const { label: _l, ...rest } = prev;
                        return val.trim() ? { ...rest, label: val } : rest;
                      });
                    }}
                    style={{ width: 84 }}
                  />
                  <NumericInput
                    aria-label={`Controller GPIO adc1Channel ${idx}`}
                    placeholder="ADC1 ch"
                    value={g.adc1Channel}
                    onChange={(n) => updateGpio(idx, (prev) => ({ ...prev, adc1Channel: n }))}
                    onClear={() =>
                      updateGpio(idx, (prev) => {
                        const { adc1Channel: _a1, ...rest } = prev;
                        return rest;
                      })
                    }
                    style={{ width: 64 }}
                  />
                  <NumericInput
                    aria-label={`Controller GPIO adc2Channel ${idx}`}
                    placeholder="ADC2 ch"
                    value={g.adc2Channel}
                    onChange={(n) => updateGpio(idx, (prev) => ({ ...prev, adc2Channel: n }))}
                    onClear={() =>
                      updateGpio(idx, (prev) => {
                        const { adc2Channel: _a2, ...rest } = prev;
                        return rest;
                      })
                    }
                    style={{ width: 64 }}
                  />
                  <NumericInput
                    aria-label={`Controller GPIO touchChannel ${idx}`}
                    placeholder="Touch ch"
                    value={g.touchChannel}
                    onChange={(n) => updateGpio(idx, (prev) => ({ ...prev, touchChannel: n }))}
                    onClear={() =>
                      updateGpio(idx, (prev) => {
                        const { touchChannel: _tc, ...rest } = prev;
                        return rest;
                      })
                    }
                    style={{ width: 68 }}
                  />
                  <select
                    aria-label={`Controller GPIO uart0 ${idx}`}
                    value={g.uart0 ?? ''}
                    onChange={(e) => {
                      const val = e.target.value;
                      updateGpio(idx, (prev) => {
                        const { uart0: _u, ...rest } = prev;
                        return val === 'tx' || val === 'rx' ? { ...rest, uart0: val } : rest;
                      });
                    }}
                  >
                    <option value="">no UART0</option>
                    <option value="tx">uart0: tx</option>
                    <option value="rx">uart0: rx</option>
                  </select>
                  <label style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                    <input
                      type="checkbox"
                      aria-label={`Controller GPIO inputOnly ${idx}`}
                      checked={Boolean(g.inputOnly)}
                      onChange={(e) =>
                        updateGpio(idx, (prev) => {
                          const { inputOnly: _io, ...rest } = prev;
                          return e.target.checked ? { ...rest, inputOnly: true } : rest;
                        })
                      }
                    />
                    <span>inputOnly</span>
                  </label>
                  <label style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                    <input
                      type="checkbox"
                      aria-label={`Controller GPIO strapping ${idx}`}
                      checked={Boolean(g.strapping)}
                      onChange={(e) =>
                        updateGpio(idx, (prev) => {
                          const { strapping: _s, ...rest } = prev;
                          return e.target.checked ? { ...rest, strapping: true } : rest;
                        })
                      }
                    />
                    <span>strapping</span>
                  </label>
                  <label style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                    <input
                      type="checkbox"
                      aria-label={`Controller GPIO flash ${idx}`}
                      checked={Boolean(g.flash)}
                      onChange={(e) =>
                        updateGpio(idx, (prev) => {
                          const { flash: _f, ...rest } = prev;
                          return e.target.checked ? { ...rest, flash: true } : rest;
                        })
                      }
                    />
                    <span>flash</span>
                  </label>
                  <button
                    type="button"
                    aria-label={`Remove controller GPIO ${idx}`}
                    onClick={() => setGpios(gpios.filter((_, i) => i !== idx))}
                  >
                    Remove GPIO
                  </button>
                </div>
              ))}
              <button
                type="button"
                onClick={() => setGpios([...gpios, { gpio: gpios.length }])}
                style={{ alignSelf: 'flex-start' }}
              >
                Add GPIO
              </button>
            </div>
          </fieldset>
        )}

        {/* Chassis-specific fields */}
        {category === 'chassis' && (
          <fieldset style={{ border: '1px solid #e2e8f0', borderRadius: 4, padding: 8 }}>
            <legend style={{ fontWeight: 600 }}>Chassis Geometry &amp; Mount Points</legend>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
                gap: 8,
              }}
            >
              <label style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                <span>Wheelbase (mm)</span>
                <NumericInput
                  step="any"
                  aria-label="Wheelbase mm"
                  value={wheelbaseMm}
                  onChange={(n) => setWheelbaseMm(n)}
                />
              </label>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                <span>Track Width (mm)</span>
                <NumericInput
                  step="any"
                  aria-label="Track width mm"
                  value={trackWidthMm}
                  onChange={(n) => setTrackWidthMm(n)}
                />
              </label>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                <span>Wheel Radius (mm)</span>
                <NumericInput
                  step="any"
                  aria-label="Wheel radius mm"
                  value={wheelRadiusMm}
                  onChange={(n) => setWheelRadiusMm(n)}
                />
              </label>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                <span>Max Steering (deg)</span>
                <NumericInput
                  step="any"
                  aria-label="Max steering deg"
                  value={maxSteeringAngleDeg}
                  onChange={(n) => setMaxSteeringAngleDeg(n)}
                />
              </label>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                <span>Steering Linkage Ratio</span>
                <NumericInput
                  step="any"
                  aria-label="Steering linkage ratio"
                  value={steeringLinkageRatio}
                  onChange={(n) => setSteeringLinkageRatio(n)}
                />
              </label>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                <span>Drive Wheels</span>
                <select
                  aria-label="Drive wheels"
                  value={driveWheels}
                  onChange={(e) => setDriveWheels(e.target.value as 'rear' | 'front' | 'all')}
                >
                  <option value="rear">rear</option>
                  <option value="front">front</option>
                  <option value="all">all</option>
                </select>
              </label>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                <span>Final Drive Ratio</span>
                <NumericInput
                  step="any"
                  aria-label="Final drive ratio"
                  value={finalDriveRatio}
                  onChange={(n) => setFinalDriveRatio(n)}
                />
              </label>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                <span>CoG X (mm)</span>
                <NumericInput
                  step="any"
                  aria-label="CoG X mm"
                  value={centreOfGravityMm.x}
                  onChange={(n) => setCentreOfGravityMm({ ...centreOfGravityMm, x: n })}
                />
              </label>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                <span>CoG Y (mm)</span>
                <NumericInput
                  step="any"
                  aria-label="CoG Y mm"
                  value={centreOfGravityMm.y}
                  onChange={(n) => setCentreOfGravityMm({ ...centreOfGravityMm, y: n })}
                />
              </label>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                <span>CoG Z (mm)</span>
                <NumericInput
                  step="any"
                  aria-label="CoG Z mm"
                  value={centreOfGravityMm.z}
                  onChange={(n) => setCentreOfGravityMm({ ...centreOfGravityMm, z: n })}
                />
              </label>
            </div>
            <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
              <strong>Mount Points:</strong>
              {mountPoints.map((mp, idx) => (
                <div
                  key={idx}
                  data-testid={`mount-point-row-${idx}`}
                  style={{
                    display: 'flex',
                    flexWrap: 'wrap',
                    gap: 6,
                    alignItems: 'center',
                    padding: 4,
                    background: '#f8fafc',
                    borderRadius: 4,
                  }}
                >
                  <input
                    type="text"
                    aria-label={`Mount point id ${idx}`}
                    placeholder="Mount id"
                    value={mp.id}
                    onChange={(e) =>
                      setMountPoints(
                        mountPoints.map((m, i) => (i === idx ? { ...m, id: e.target.value } : m)),
                      )
                    }
                    style={{ width: 110 }}
                  />
                  <NumericInput
                    step="any"
                    aria-label={`Mount point ${idx} X mm`}
                    placeholder="X (mm)"
                    value={mp.positionMm.x}
                    onChange={(n) =>
                      setMountPoints(
                        mountPoints.map((m, i) =>
                          i === idx ? { ...m, positionMm: { ...m.positionMm, x: n } } : m,
                        ),
                      )
                    }
                    style={{ width: 70 }}
                  />
                  <NumericInput
                    step="any"
                    aria-label={`Mount point ${idx} Y mm`}
                    placeholder="Y (mm)"
                    value={mp.positionMm.y}
                    onChange={(n) =>
                      setMountPoints(
                        mountPoints.map((m, i) =>
                          i === idx ? { ...m, positionMm: { ...m.positionMm, y: n } } : m,
                        ),
                      )
                    }
                    style={{ width: 70 }}
                  />
                  <NumericInput
                    step="any"
                    aria-label={`Mount point ${idx} Z mm`}
                    placeholder="Z (mm)"
                    value={mp.positionMm.z}
                    onChange={(n) =>
                      setMountPoints(
                        mountPoints.map((m, i) =>
                          i === idx ? { ...m, positionMm: { ...m.positionMm, z: n } } : m,
                        ),
                      )
                    }
                    style={{ width: 70 }}
                  />
                  <NumericInput
                    step="any"
                    aria-label={`Mount point ${idx} yaw deg`}
                    placeholder="Yaw (deg)"
                    value={mp.yawDeg}
                    onChange={(n) =>
                      setMountPoints(
                        mountPoints.map((m, i) => (i === idx ? { ...m, yawDeg: n } : m)),
                      )
                    }
                    style={{ width: 70 }}
                  />
                  <NumericInput
                    step="any"
                    aria-label={`Mount point ${idx} pitch deg`}
                    placeholder="Pitch (deg)"
                    value={mp.pitchDeg}
                    onChange={(n) =>
                      setMountPoints(
                        mountPoints.map((m, i) => (i === idx ? { ...m, pitchDeg: n } : m)),
                      )
                    }
                    style={{ width: 70 }}
                  />
                  <button
                    type="button"
                    aria-label={`Remove mount point ${idx}`}
                    onClick={() => setMountPoints(mountPoints.filter((_, i) => i !== idx))}
                  >
                    Remove Mount Point
                  </button>
                </div>
              ))}
              <button
                type="button"
                onClick={() =>
                  setMountPoints([
                    ...mountPoints,
                    {
                      id: `mount-${mountPoints.length + 1}`,
                      positionMm: { x: 0, y: 50, z: 0 },
                      yawDeg: 0,
                      pitchDeg: 0,
                    },
                  ])
                }
                style={{ alignSelf: 'flex-start' }}
              >
                Add Mount Point
              </button>
            </div>
          </fieldset>
        )}

        {/* Pins section */}
        <fieldset style={{ border: '1px solid #e2e8f0', borderRadius: 4, padding: 8 }}>
          <legend style={{ fontWeight: 600 }}>Pins ({pins.length})</legend>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {pins.map((pin, idx) => {
              const vMode = getPinVoltageMode(pin.voltage);
              return (
                <div
                  key={idx}
                  data-testid={`pin-def-row-${idx}`}
                  style={{
                    display: 'flex',
                    flexWrap: 'wrap',
                    gap: 6,
                    alignItems: 'center',
                    padding: 4,
                    background: '#f8fafc',
                    borderRadius: 4,
                  }}
                >
                  <input
                    type="text"
                    aria-label={`Pin ${idx} name`}
                    value={pin.name}
                    onChange={(e) => updatePin(idx, (prev) => ({ ...prev, name: e.target.value }))}
                    placeholder="Pin name"
                    style={{ width: 84, fontFamily: 'monospace' }}
                  />
                  <select
                    aria-label={`Pin ${idx} kind`}
                    value={pin.kind}
                    onChange={(e) =>
                      updatePin(idx, (prev) => ({
                        ...prev,
                        kind: e.target.value as PinDefinition['kind'],
                      }))
                    }
                  >
                    {PinKind.options.map((k) => (
                      <option key={k} value={k}>
                        {k}
                      </option>
                    ))}
                  </select>
                  <select
                    aria-label={`Pin ${idx} voltage mode`}
                    value={vMode}
                    onChange={(e) => {
                      const nextMode = e.target.value as PinVoltageMode;
                      updatePin(idx, (prev) => {
                        const { voltage: _v, ...rest } = prev;
                        if (nextMode === 'none') return rest;
                        if (nextMode === 'supply') return { ...rest, voltage: 'supply' };
                        if (nextMode === 'number') return { ...rest, voltage: 3.3 };
                        return { ...rest, voltage: { min: 3.0, max: 5.0 } };
                      });
                    }}
                  >
                    <option value="none">no voltage</option>
                    <option value="number">fixed V</option>
                    <option value="supply">supply V</option>
                    <option value="range">min..max V</option>
                  </select>
                  {(vMode === 'none' || vMode === 'number') && (
                    <NumericInput
                      step="any"
                      aria-label={`Pin ${idx} voltage`}
                      placeholder="Voltage (V)"
                      value={typeof pin.voltage === 'number' ? pin.voltage : undefined}
                      onChange={(n) => updatePin(idx, (prev) => ({ ...prev, voltage: n }))}
                      onClear={() =>
                        updatePin(idx, (prev) => {
                          const { voltage: _v, ...rest } = prev;
                          return rest;
                        })
                      }
                      style={{ width: 80 }}
                    />
                  )}
                  {vMode === 'range' && typeof pin.voltage === 'object' && pin.voltage !== null && (
                    <>
                      <NumericInput
                        step="any"
                        aria-label={`Pin ${idx} voltage min`}
                        placeholder="Min V"
                        value={pin.voltage.min}
                        onChange={(n) =>
                          updatePin(idx, (prev) => ({
                            ...prev,
                            voltage:
                              typeof prev.voltage === 'object' && prev.voltage !== null
                                ? { ...prev.voltage, min: n }
                                : { min: n, max: n },
                          }))
                        }
                        style={{ width: 68 }}
                      />
                      <NumericInput
                        step="any"
                        aria-label={`Pin ${idx} voltage max`}
                        placeholder="Max V"
                        value={pin.voltage.max}
                        onChange={(n) =>
                          updatePin(idx, (prev) => ({
                            ...prev,
                            voltage:
                              typeof prev.voltage === 'object' && prev.voltage !== null
                                ? { ...prev.voltage, max: n }
                                : { min: n, max: n },
                          }))
                        }
                        style={{ width: 68 }}
                      />
                    </>
                  )}
                  <NumericInput
                    step="any"
                    aria-label={`Pin ${idx} maxInputV`}
                    placeholder="Max in (V)"
                    value={pin.maxInputV}
                    onChange={(n) => updatePin(idx, (prev) => ({ ...prev, maxInputV: n }))}
                    onClear={() =>
                      updatePin(idx, (prev) => {
                        const { maxInputV: _m, ...rest } = prev;
                        return rest;
                      })
                    }
                    style={{ width: 78 }}
                  />
                  {pin.kind === 'power-out' && (
                    <NumericInput
                      step="any"
                      aria-label={`Pin ${idx} maxCurrentMa`}
                      placeholder="Max mA"
                      value={pin.maxCurrentMa}
                      onChange={(n) => updatePin(idx, (prev) => ({ ...prev, maxCurrentMa: n }))}
                      onClear={() =>
                        updatePin(idx, (prev) => {
                          const { maxCurrentMa: _c, ...rest } = prev;
                          return rest;
                        })
                      }
                      style={{ width: 78 }}
                    />
                  )}
                  <input
                    type="text"
                    aria-label={`Pin ${idx} description`}
                    placeholder="Description"
                    value={pin.description ?? ''}
                    onChange={(e) => {
                      const val = e.target.value;
                      updatePin(idx, (prev) => {
                        const { description: _d, ...rest } = prev;
                        return val.trim() ? { ...rest, description: val } : rest;
                      });
                    }}
                    style={{ width: 110 }}
                  />
                  <label style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                    <input
                      type="checkbox"
                      aria-label={`Pin ${idx} optional`}
                      checked={Boolean(pin.optional)}
                      onChange={(e) =>
                        updatePin(idx, (prev) => {
                          const { optional: _o, ...rest } = prev;
                          return e.target.checked ? { ...rest, optional: true } : rest;
                        })
                      }
                    />
                    <span>optional</span>
                  </label>
                  <button
                    type="button"
                    aria-label={`Remove pin ${idx}`}
                    onClick={() => setPins(pins.filter((_, i) => i !== idx))}
                  >
                    Remove
                  </button>
                </div>
              );
            })}
            <button
              type="button"
              onClick={() =>
                setPins([...pins, { name: `PIN_${pins.length + 1}`, kind: 'digital-in' }])
              }
              style={{ alignSelf: 'flex-start' }}
            >
              Add Pin
            </button>
          </div>
        </fieldset>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button
            type="submit"
            disabled={submitting}
            style={{
              padding: '6px 14px',
              background: '#16a34a',
              color: '#ffffff',
              border: 'none',
              borderRadius: 4,
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            {submitting ? 'Saving...' : 'Save Custom Part'}
          </button>
        </div>
      </form>
    </section>
  );
}
