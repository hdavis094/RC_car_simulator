import { electricalOf, type PartDefinition } from '@rcsim/schema';
import type { ReactNode } from 'react';
import { useWorkbenchStore } from './workbench-store.ts';

const hex = (address: number): string => `0x${address.toString(16).toUpperCase().padStart(2, '0')}`;

function formatParamValue(value: unknown): string {
  if (Array.isArray(value)) {
    return value
      .map((item) =>
        typeof item === 'object' && item !== null ? JSON.stringify(item) : String(item),
      )
      .join(', ');
  }
  if (typeof value === 'object' && value !== null) {
    return JSON.stringify(value);
  }
  return String(value);
}

export function PartInspector(): ReactNode {
  const car = useWorkbenchStore((s) => s.car);
  const catalog = useWorkbenchStore((s) => s.catalog);
  const selectedInstanceId = useWorkbenchStore((s) => s.selectedInstanceId);
  const selectedPartId = useWorkbenchStore((s) => s.selectedPartId);

  const allCarParts = [car.controller, car.chassis, ...car.parts];
  const selectedInstance = selectedInstanceId
    ? allCarParts.find((p) => p.instanceId === selectedInstanceId)
    : undefined;
  const resolvedPartId = selectedInstance?.partId ?? selectedPartId ?? car.controller.partId;
  const definition: PartDefinition | undefined = catalog.get(resolvedPartId);

  if (!definition) {
    return (
      <section
        aria-label="Part inspector"
        style={{
          border: '1px solid #cbd5e1',
          borderRadius: 6,
          padding: 12,
          background: '#ffffff',
        }}
      >
        <h2 style={{ margin: '0 0 8px', fontSize: 16 }}>Part Inspector</h2>
        <p style={{ margin: 0, fontSize: 12, color: '#64748b' }}>
          Select a part to inspect its definition.
        </p>
      </section>
    );
  }

  const electrical = electricalOf(definition);

  return (
    <section
      aria-label="Part inspector"
      data-testid="part-inspector"
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        border: '1px solid #cbd5e1',
        borderRadius: 6,
        padding: 12,
        background: '#ffffff',
        fontSize: 12,
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <h2 style={{ margin: 0, fontSize: 16 }}>Part Inspector</h2>
        {selectedInstance && (
          <code style={{ fontSize: 12, color: '#2563eb' }}>
            instance: {selectedInstance.instanceId}
          </code>
        )}
      </div>

      <div>
        <div style={{ fontSize: 14, fontWeight: 600 }}>{definition.name}</div>
        <div style={{ color: '#475569', display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 2 }}>
          <code>{definition.id}</code>
          <span>• Category: {definition.category}</span>
          {definition.manufacturer && <span>• Manufacturer: {definition.manufacturer}</span>}
        </div>
        {definition.description && (
          <p style={{ margin: '6px 0 0', color: '#334155' }}>{definition.description}</p>
        )}
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
          gap: 8,
          background: '#f8fafc',
          padding: 8,
          borderRadius: 4,
          border: '1px solid #e2e8f0',
        }}
      >
        <div>
          <strong>Physical</strong>
          <div>Mass: {definition.massG} g</div>
          <div>
            Dimensions: {definition.dimensionsMm.width} × {definition.dimensionsMm.height} ×{' '}
            {definition.dimensionsMm.length} mm
          </div>
        </div>

        {electrical && (
          <div data-testid="inspector-electrical">
            <strong>Electrical Values</strong>
            <div>
              Supply: {electrical.supplyV.min}–{electrical.supplyV.max} V
            </div>
            <div>
              Logic level:{' '}
              {typeof electrical.logicLevelV === 'number'
                ? `${electrical.logicLevelV} V`
                : electrical.logicLevelV}
            </div>
            <div>
              Current: typical {electrical.currentMa.typical} mA, peak {electrical.currentMa.peak}{' '}
              mA
            </div>
            {definition.category === 'controller' && (
              <div>Max GPIO input: {definition.gpioMaxInputV} V</div>
            )}
          </div>
        )}

        {'i2c' in definition && definition.i2c && (
          <div data-testid="inspector-i2c">
            <strong>I²C Bus</strong>
            <div>
              Default address: {hex(definition.i2c.defaultAddress)} ({definition.i2c.defaultAddress}
              )
            </div>
            <div>Addressing: {definition.i2c.addressing.kind}</div>
          </div>
        )}

        {definition.category === 'chassis' && (
          <div data-testid="inspector-chassis">
            <strong>Chassis Geometry</strong>
            <div>Wheelbase: {definition.wheelbaseMm} mm</div>
            <div>Track width: {definition.trackWidthMm} mm</div>
            <div>Drive wheels: {definition.driveWheels}</div>
          </div>
        )}
      </div>

      {'behavior' in definition && definition.behavior && (
        <div
          data-testid="inspector-behavior"
          style={{
            background: '#f8fafc',
            padding: 8,
            borderRadius: 4,
            border: '1px solid #e2e8f0',
          }}
        >
          <div style={{ marginBottom: 4 }}>
            <strong>Behavior Template:</strong> <code>{definition.behavior.template}</code>
          </div>
          <dl
            style={{
              margin: 0,
              display: 'grid',
              gridTemplateColumns: 'max-content 1fr',
              columnGap: 12,
              rowGap: 2,
            }}
          >
            {Object.entries(definition.behavior.params).map(([key, value]) => (
              <div key={key} style={{ display: 'contents' }}>
                <dt style={{ fontFamily: 'monospace', color: '#475569' }}>{key}</dt>
                <dd style={{ margin: 0 }}>{formatParamValue(value)}</dd>
              </div>
            ))}
          </dl>
        </div>
      )}

      <div data-testid="inspector-datasheets">
        <strong>Datasheet Links</strong>
        <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
          {definition.sources.map((url) => (
            <li key={url}>
              <a
                href={url}
                target="_blank"
                rel="noreferrer"
                style={{ color: '#2563eb', wordBreak: 'break-all' }}
              >
                {url}
              </a>
            </li>
          ))}
        </ul>
      </div>

      {definition.notes && (
        <div style={{ color: '#475569', fontSize: 11 }}>
          <strong>Notes:</strong> {definition.notes}
        </div>
      )}
    </section>
  );
}
