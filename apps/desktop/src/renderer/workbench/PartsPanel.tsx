import { PART_CATEGORIES, type PartCategory, type PartDefinition } from '@rcsim/schema';
import { useState, type ReactNode } from 'react';
import { useWorkbenchStore } from './workbench-store.ts';

const CATEGORY_LABELS: Record<PartCategory, string> = {
  controller: 'Controller',
  chassis: 'Chassis',
  actuator: 'Actuator',
  sensor: 'Sensor',
  power: 'Power',
  passive: 'Passive',
};

interface InstanceIdEditorProps {
  readonly instanceId: string;
  readonly onRename: (oldId: string, newId: string) => { ok: true } | { ok: false; error: string };
}

function InstanceIdEditor({ instanceId, onRename }: InstanceIdEditorProps): ReactNode {
  const [draft, setDraft] = useState(instanceId);
  const [prevInstanceId, setPrevInstanceId] = useState(instanceId);
  const [error, setError] = useState<string | null>(null);

  if (instanceId !== prevInstanceId) {
    setPrevInstanceId(instanceId);
    setDraft(instanceId);
    setError(null);
  }

  const commit = (value: string) => {
    const trimmed = value.trim();
    if (trimmed === instanceId) {
      setError(null);
      return;
    }
    const result = onRename(instanceId, trimmed);
    if (!result.ok) {
      setError(result.error);
    } else {
      setError(null);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <input
        type="text"
        aria-label={`Instance id for ${instanceId}`}
        value={draft}
        onChange={(e) => {
          const val = e.target.value;
          setDraft(val);
          commit(val);
        }}
        onBlur={() => {
          if (error) {
            setDraft(instanceId);
            setError(null);
          }
        }}
        style={{
          fontFamily: 'monospace',
          fontSize: 12,
          padding: '2px 6px',
          border: error ? '1px solid #d32f2f' : '1px solid #cbd5e1',
          borderRadius: 4,
          width: 130,
        }}
      />
      {error && <span style={{ color: '#d32f2f', fontSize: 11 }}>{error}</span>}
    </div>
  );
}

export function PartsPanel(): ReactNode {
  const car = useWorkbenchStore((s) => s.car);
  const listing = useWorkbenchStore((s) => s.listing);
  const catalog = useWorkbenchStore((s) => s.catalog);
  const searchQuery = useWorkbenchStore((s) => s.searchQuery);
  const selectedInstanceId = useWorkbenchStore((s) => s.selectedInstanceId);
  const selectedPartId = useWorkbenchStore((s) => s.selectedPartId);
  const setSearchQuery = useWorkbenchStore((s) => s.setSearchQuery);
  const addPart = useWorkbenchStore((s) => s.addPart);
  const removePart = useWorkbenchStore((s) => s.removePart);
  const renameInstance = useWorkbenchStore((s) => s.renameInstance);
  const selectInstance = useWorkbenchStore((s) => s.selectInstance);
  const selectCatalogPart = useWorkbenchStore((s) => s.selectCatalogPart);
  const setNewPartOpen = useWorkbenchStore((s) => s.setNewPartOpen);

  const [customInstanceId, setCustomInstanceId] = useState('');
  const [addError, setAddError] = useState<string | null>(null);

  const customIds = new Set(listing.custom.map((c) => c.definition.id));
  const allDefinitions: PartDefinition[] = [
    ...listing.builtIn,
    ...listing.custom.map((c) => c.definition),
  ];

  const normalizedQuery = searchQuery.trim().toLowerCase();
  const filteredDefinitions = allDefinitions.filter((def) => {
    if (!normalizedQuery) return true;
    return (
      def.name.toLowerCase().includes(normalizedQuery) ||
      def.id.toLowerCase().includes(normalizedQuery) ||
      def.category.toLowerCase().includes(normalizedQuery) ||
      (def.description?.toLowerCase().includes(normalizedQuery) ?? false)
    );
  });

  const handleAdd = (partId: string) => {
    const res = addPart(partId, customInstanceId);
    if (!res.ok) {
      setAddError(res.error);
    } else {
      setAddError(null);
      setCustomInstanceId('');
    }
  };

  const carEntries = [
    {
      role: 'Controller' as const,
      instanceId: car.controller.instanceId,
      partId: car.controller.partId,
      removable: false,
    },
    {
      role: 'Chassis' as const,
      instanceId: car.chassis.instanceId,
      partId: car.chassis.partId,
      removable: false,
    },
    ...car.parts.map((part) => ({
      role: 'Part' as const,
      instanceId: part.instanceId,
      partId: part.partId,
      removable: true,
    })),
  ];

  return (
    <section
      aria-label="Parts panel"
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        border: '1px solid #cbd5e1',
        borderRadius: 6,
        padding: 12,
        background: '#f8fafc',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h2 style={{ margin: 0, fontSize: 16 }}>Car Parts</h2>
        <span style={{ fontSize: 12, color: '#475569' }}>
          1 controller, 1 chassis, {car.parts.length} other
        </span>
      </div>

      <div
        data-testid="car-parts-list"
        style={{ display: 'flex', flexDirection: 'column', gap: 6 }}
      >
        {carEntries.map((entry) => {
          const def = catalog.get(entry.partId);
          const isSelected = selectedInstanceId === entry.instanceId;
          return (
            <div
              key={entry.instanceId}
              data-testid={`car-part-${entry.instanceId}`}
              onClick={() => selectInstance(entry.instanceId)}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 8,
                padding: '6px 8px',
                borderRadius: 4,
                border: isSelected ? '1px solid #2563eb' : '1px solid #e2e8f0',
                background: isSelected ? '#eff6ff' : '#ffffff',
                cursor: 'pointer',
              }}
            >
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <InstanceIdEditor instanceId={entry.instanceId} onRename={renameInstance} />
                  {!entry.removable && (
                    <span
                      style={{
                        fontSize: 10,
                        padding: '1px 5px',
                        borderRadius: 3,
                        background: '#e2e8f0',
                        color: '#334155',
                        fontWeight: 600,
                      }}
                    >
                      {entry.role}
                    </span>
                  )}
                </div>
                <span style={{ fontSize: 12, color: '#475569' }}>
                  {def ? def.name : entry.partId} ({entry.partId})
                </span>
              </div>
              {entry.removable && (
                <button
                  type="button"
                  aria-label={`Remove ${entry.instanceId}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    removePart(entry.instanceId);
                  }}
                  style={{
                    fontSize: 12,
                    padding: '2px 8px',
                    color: '#b91c1c',
                    background: '#fef2f2',
                    border: '1px solid #fecaca',
                    borderRadius: 4,
                    cursor: 'pointer',
                  }}
                >
                  Remove
                </button>
              )}
            </div>
          );
        })}
      </div>

      <hr style={{ border: 0, borderTop: '1px solid #e2e8f0', margin: '4px 0' }} />

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h2 style={{ margin: 0, fontSize: 16 }}>Catalog</h2>
        <button
          type="button"
          onClick={() => setNewPartOpen(true)}
          style={{
            fontSize: 12,
            padding: '4px 8px',
            background: '#2563eb',
            color: '#ffffff',
            border: 'none',
            borderRadius: 4,
            cursor: 'pointer',
          }}
        >
          New Part
        </button>
      </div>

      <div style={{ display: 'flex', gap: 6 }}>
        <input
          type="search"
          aria-label="Search catalog"
          placeholder="Search parts..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          style={{
            flex: 1,
            fontSize: 12,
            padding: '4px 8px',
            border: '1px solid #cbd5e1',
            borderRadius: 4,
          }}
        />
        <input
          type="text"
          aria-label="New instance id"
          placeholder="Optional instance_id"
          value={customInstanceId}
          onChange={(e) => setCustomInstanceId(e.target.value)}
          style={{
            width: 130,
            fontFamily: 'monospace',
            fontSize: 12,
            padding: '4px 8px',
            border: '1px solid #cbd5e1',
            borderRadius: 4,
          }}
        />
      </div>

      {addError && (
        <div role="alert" style={{ color: '#d32f2f', fontSize: 12 }}>
          {addError}
        </div>
      )}

      {listing.problems.length > 0 && (
        <div
          role="alert"
          style={{
            padding: 8,
            background: '#fffbeb',
            border: '1px solid #fde68a',
            borderRadius: 4,
            fontSize: 12,
            color: '#92400e',
          }}
        >
          <strong>Catalog file problems:</strong>
          <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
            {listing.problems.map((p) => (
              <li key={`${p.source}:${p.message}`}>
                <code>{p.source}</code>: {p.message}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div
        data-testid="catalog-groups"
        style={{ display: 'flex', flexDirection: 'column', gap: 10 }}
      >
        {PART_CATEGORIES.map((category) => {
          const items = filteredDefinitions.filter((d) => d.category === category);
          if (items.length === 0) return null;
          return (
            <div key={category} data-testid={`catalog-category-${category}`}>
              <h3
                style={{
                  margin: '0 0 4px',
                  fontSize: 12,
                  textTransform: 'uppercase',
                  color: '#475569',
                  letterSpacing: 0.4,
                }}
              >
                {CATEGORY_LABELS[category]}
              </h3>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {items.map((def) => {
                  const isCustom = customIds.has(def.id);
                  const isInspected = selectedInstanceId === null && selectedPartId === def.id;
                  const isCurrentSingleton =
                    (def.category === 'controller' && car.controller.partId === def.id) ||
                    (def.category === 'chassis' && car.chassis.partId === def.id);

                  return (
                    <div
                      key={def.id}
                      data-testid={`catalog-part-${def.id}`}
                      onClick={() => selectCatalogPart(def.id)}
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        gap: 8,
                        padding: '6px 8px',
                        borderRadius: 4,
                        border: isInspected ? '1px solid #2563eb' : '1px solid #e2e8f0',
                        background: isInspected ? '#eff6ff' : '#ffffff',
                        cursor: 'pointer',
                      }}
                    >
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <span style={{ fontSize: 13, fontWeight: 500 }}>{def.name}</span>
                          {isCustom && (
                            <span
                              style={{
                                fontSize: 10,
                                padding: '1px 5px',
                                borderRadius: 3,
                                background: '#dbeafe',
                                color: '#1e40af',
                              }}
                            >
                              Custom
                            </span>
                          )}
                        </div>
                        <code style={{ fontSize: 11, color: '#64748b' }}>{def.id}</code>
                      </div>
                      <button
                        type="button"
                        aria-label={`Add ${def.name}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          handleAdd(def.id);
                        }}
                        style={{
                          fontSize: 12,
                          padding: '3px 8px',
                          borderRadius: 4,
                          border: '1px solid #cbd5e1',
                          background: isCurrentSingleton ? '#f1f5f9' : '#ffffff',
                          cursor: 'pointer',
                        }}
                      >
                        {def.category === 'controller' || def.category === 'chassis'
                          ? isCurrentSingleton
                            ? 'Selected'
                            : 'Select'
                          : 'Add'}
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
