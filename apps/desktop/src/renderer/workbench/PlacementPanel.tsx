import type { ChassisDefinition, Part, Placement } from '@rcsim/schema';
import type { ReactNode } from 'react';
import { CarPreview3D } from './CarPreview3D.tsx';
import { NumericInput } from './NumericInput.tsx';
import { useWorkbenchStore } from './workbench-store.ts';

export function PlacementPanel(): ReactNode {
  const car = useWorkbenchStore((s) => s.car);
  const catalog = useWorkbenchStore((s) => s.catalog);
  const setPlacement = useWorkbenchStore((s) => s.setPlacement);
  const selectInstance = useWorkbenchStore((s) => s.selectInstance);

  const chassisDef = catalog.get(car.chassis.partId) as ChassisDefinition | undefined;
  const mountPoints = chassisDef?.category === 'chassis' ? chassisDef.mountPoints : [];
  const defaultMount = mountPoints[0]?.id ?? 'front-centre';

  // Sensors and actuators
  const placeableParts: Part[] = car.parts.filter((part) => {
    const def = catalog.get(part.partId);
    return def?.category === 'sensor' || def?.category === 'actuator';
  });

  const updateMount = (part: Part, mount: string) => {
    if (!mount) {
      setPlacement(part.instanceId, undefined);
      return;
    }
    const next: Placement = {
      ...(part.placement ?? {}),
      mount,
    };
    setPlacement(part.instanceId, next);
  };

  const updateOffset = (part: Part, axis: 'x' | 'y' | 'z', value: number) => {
    const currentPlacement = part.placement ?? { mount: defaultMount };
    const currentOffset = currentPlacement.offsetMm ?? { x: 0, y: 0, z: 0 };
    const nextOffset = {
      ...currentOffset,
      [axis]: Number.isNaN(value) ? 0 : value,
    };
    setPlacement(part.instanceId, {
      ...currentPlacement,
      offsetMm: nextOffset,
    });
  };

  const updateAngle = (part: Part, field: 'yawDeg' | 'pitchDeg', value: number) => {
    const currentPlacement = part.placement ?? { mount: defaultMount };
    setPlacement(part.instanceId, {
      ...currentPlacement,
      [field]: Number.isNaN(value) ? 0 : value,
    });
  };

  return (
    <section
      aria-label="Placement"
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        border: '1px solid #cbd5e1',
        borderRadius: 6,
        padding: 12,
        background: '#ffffff',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h2 style={{ margin: 0, fontSize: 16 }}>Placement &amp; 3D Preview</h2>
        <span style={{ fontSize: 12, color: '#475569' }}>
          {mountPoints.length} chassis mount points
        </span>
      </div>

      <CarPreview3D car={car} catalog={catalog} />

      <div style={{ overflowX: 'auto' }}>
        <table
          aria-label="Part placement table"
          style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}
        >
          <thead>
            <tr style={{ borderBottom: '2px solid #e2e8f0', textAlign: 'left', color: '#475569' }}>
              <th style={{ padding: '6px 8px' }}>Part</th>
              <th style={{ padding: '6px 8px' }}>Category</th>
              <th style={{ padding: '6px 8px' }}>Mount Point</th>
              <th style={{ padding: '6px 8px' }}>Offset X (mm)</th>
              <th style={{ padding: '6px 8px' }}>Offset Y (mm)</th>
              <th style={{ padding: '6px 8px' }}>Offset Z (mm)</th>
              <th style={{ padding: '6px 8px' }}>Yaw (deg)</th>
              <th style={{ padding: '6px 8px' }}>Pitch (deg)</th>
            </tr>
          </thead>
          <tbody>
            {placeableParts.map((part) => {
              const def = catalog.get(part.partId);
              const placement = part.placement;
              const offset = placement?.offsetMm ?? { x: 0, y: 0, z: 0 };
              const yaw = placement?.yawDeg ?? 0;
              const pitch = placement?.pitchDeg ?? 0;

              return (
                <tr
                  key={part.instanceId}
                  data-testid={`placement-row-${part.instanceId}`}
                  onClick={() => selectInstance(part.instanceId)}
                  style={{ borderBottom: '1px solid #f1f5f9' }}
                >
                  <td style={{ padding: '6px 8px', fontFamily: 'monospace', fontWeight: 600 }}>
                    {part.instanceId}
                  </td>
                  <td style={{ padding: '6px 8px', color: '#475569' }}>
                    {def?.category ?? 'unknown'}
                  </td>
                  <td style={{ padding: '6px 8px' }}>
                    <select
                      aria-label={`Mount point for ${part.instanceId}`}
                      value={placement?.mount ?? ''}
                      onChange={(e) => updateMount(part, e.target.value)}
                      style={{
                        fontSize: 12,
                        padding: '2px 6px',
                        borderRadius: 4,
                        border: '1px solid #cbd5e1',
                      }}
                    >
                      <option value="">Unmounted</option>
                      {mountPoints.map((mp) => (
                        <option key={mp.id} value={mp.id}>
                          {mp.id} ({mp.positionMm.x}, {mp.positionMm.y}, {mp.positionMm.z} mm)
                        </option>
                      ))}
                      {placement?.mount && !mountPoints.some((m) => m.id === placement.mount) && (
                        <option value={placement.mount}>{placement.mount} (invalid)</option>
                      )}
                    </select>
                  </td>
                  <td style={{ padding: '6px 8px' }}>
                    <NumericInput
                      ariaLabel={`Offset X for ${part.instanceId}`}
                      value={offset.x}
                      disabled={!placement}
                      onChange={(val) => updateOffset(part, 'x', val)}
                      style={{ width: 64, fontSize: 12, padding: '2px 4px' }}
                    />
                  </td>
                  <td style={{ padding: '6px 8px' }}>
                    <NumericInput
                      ariaLabel={`Offset Y for ${part.instanceId}`}
                      value={offset.y}
                      disabled={!placement}
                      onChange={(val) => updateOffset(part, 'y', val)}
                      style={{ width: 64, fontSize: 12, padding: '2px 4px' }}
                    />
                  </td>
                  <td style={{ padding: '6px 8px' }}>
                    <NumericInput
                      ariaLabel={`Offset Z for ${part.instanceId}`}
                      value={offset.z}
                      disabled={!placement}
                      onChange={(val) => updateOffset(part, 'z', val)}
                      style={{ width: 64, fontSize: 12, padding: '2px 4px' }}
                    />
                  </td>
                  <td style={{ padding: '6px 8px' }}>
                    <NumericInput
                      ariaLabel={`Yaw for ${part.instanceId}`}
                      value={yaw}
                      disabled={!placement}
                      onChange={(val) => updateAngle(part, 'yawDeg', val)}
                      style={{ width: 64, fontSize: 12, padding: '2px 4px' }}
                    />
                  </td>
                  <td style={{ padding: '6px 8px' }}>
                    <NumericInput
                      ariaLabel={`Pitch for ${part.instanceId}`}
                      value={pitch}
                      disabled={!placement}
                      onChange={(val) => updateAngle(part, 'pitchDeg', val)}
                      style={{ width: 64, fontSize: 12, padding: '2px 4px' }}
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
