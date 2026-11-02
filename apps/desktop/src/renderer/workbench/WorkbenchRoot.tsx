import { canRun, generateCarConfigHeader } from '@rcsim/schema';
import { useEffect, type ReactNode } from 'react';
import type { RcsimApi } from '../../shared/ipc.ts';
import { NewPartForm } from './NewPartForm.tsx';
import { PartInspector } from './PartInspector.tsx';
import { PartsPanel } from './PartsPanel.tsx';
import { PinAssignmentTable } from './PinAssignmentTable.tsx';
import { PlacementPanel } from './PlacementPanel.tsx';
import { catalogFromListing, resolveRcsimApi, useWorkbenchStore } from './workbench-store.ts';

export interface WorkbenchRootProps {
  readonly api?: RcsimApi;
}

/** Root of the Workbench environment (P1-E). */
export function WorkbenchRoot({ api }: WorkbenchRootProps = {}): ReactNode {
  const car = useWorkbenchStore((s) => s.car);
  const catalog = useWorkbenchStore((s) => s.catalog);
  const issues = useWorkbenchStore((s) => s.issues);
  const dirty = useWorkbenchStore((s) => s.dirty);
  const saving = useWorkbenchStore((s) => s.saving);
  const saveStatus = useWorkbenchStore((s) => s.saveStatus);
  const loadError = useWorkbenchStore((s) => s.loadError);
  const load = useWorkbenchStore((s) => s.load);
  const setCarName = useWorkbenchStore((s) => s.setCarName);
  const setCarWifi = useWorkbenchStore((s) => s.setCarWifi);
  const saveCar = useWorkbenchStore((s) => s.saveCar);

  useEffect(() => {
    const resolved = resolveRcsimApi(api);
    void load(resolved);

    const unsubCatalog =
      typeof resolved.catalog?.onChange === 'function'
        ? resolved.catalog.onChange((listing) => {
            const nextCatalog = catalogFromListing(listing);
            useWorkbenchStore.setState({ listing, catalog: nextCatalog });
          })
        : undefined;

    const unsubFiles =
      typeof resolved.project?.onFileChange === 'function'
        ? resolved.project.onFileChange((change) => {
            if (change.path === 'car.json' && !useWorkbenchStore.getState().saving) {
              void load(resolved);
            }
          })
        : undefined;

    return () => {
      unsubCatalog?.();
      unsubFiles?.();
    };
  }, [api, load]);

  const errorCount = issues.filter((i) => i.severity === 'error').length;
  const warningCount = issues.filter((i) => i.severity === 'warning').length;
  const runnable = canRun(issues);
  const headerPreview = generateCarConfigHeader(car, catalog);

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        height: '100%',
        color: '#0f172a',
      }}
    >
      <header
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: 12,
          padding: '8px 12px',
          background: '#f8fafc',
          border: '1px solid #cbd5e1',
          borderRadius: 6,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <h1 style={{ margin: 0, fontSize: 20 }}>Workbench</h1>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
            <span>Car:</span>
            <input
              type="text"
              aria-label="Car name"
              value={car.name}
              onChange={(e) => setCarName(e.target.value)}
              style={{
                fontSize: 13,
                padding: '3px 8px',
                border: '1px solid #cbd5e1',
                borderRadius: 4,
              }}
            />
          </label>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 13 }}>
            <input
              type="checkbox"
              aria-label="Wi-Fi enabled"
              checked={car.wifi}
              onChange={(e) => setCarWifi(e.target.checked)}
            />
            <span>Wi-Fi</span>
          </label>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span
            data-testid="workbench-wiring-badge"
            style={{
              fontSize: 12,
              padding: '3px 8px',
              borderRadius: 4,
              fontWeight: 600,
              background: runnable ? '#dcfce7' : '#fee2e2',
              color: runnable ? '#166534' : '#991b1b',
            }}
          >
            {errorCount === 0 && warningCount === 0
              ? '0 errors'
              : `${errorCount} error(s), ${warningCount} warning(s)`}
          </span>

          <button
            type="button"
            onClick={() => void saveCar()}
            disabled={saving}
            style={{
              fontSize: 13,
              fontWeight: 600,
              padding: '5px 14px',
              background: '#2563eb',
              color: '#ffffff',
              border: 'none',
              borderRadius: 4,
              cursor: 'pointer',
            }}
          >
            {saving ? 'Saving...' : dirty ? 'Save *' : 'Save'}
          </button>
        </div>
      </header>

      {loadError && (
        <div
          role="alert"
          data-testid="workbench-load-error"
          style={{
            padding: '8px 12px',
            borderRadius: 4,
            background: '#fef2f2',
            border: '1px solid #fca5a5',
            color: '#b91c1c',
            fontSize: 12,
          }}
        >
          Failed to read car.json: {loadError}
        </div>
      )}

      {saveStatus && (
        <div
          role="status"
          data-testid="workbench-save-status"
          data-flagged={saveStatus.flaggedErrors > 0 ? 'true' : 'false'}
          style={{
            padding: '8px 12px',
            borderRadius: 4,
            background: !saveStatus.ok
              ? '#fef2f2'
              : saveStatus.flaggedErrors > 0
                ? '#fffbeb'
                : '#f0fdf4',
            border: !saveStatus.ok
              ? '1px solid #fca5a5'
              : saveStatus.flaggedErrors > 0
                ? '1px solid #fcd34d'
                : '1px solid #bbf7d0',
            color: !saveStatus.ok
              ? '#b91c1c'
              : saveStatus.flaggedErrors > 0
                ? '#b45309'
                : '#166534',
            fontSize: 12,
          }}
        >
          {saveStatus.message}
        </div>
      )}

      <NewPartForm />

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(280px, 340px) 1fr',
          gap: 12,
          alignItems: 'start',
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <PartsPanel />
          <PartInspector />
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0 }}>
          <PinAssignmentTable />
          <PlacementPanel />
          <details
            style={{
              border: '1px solid #cbd5e1',
              borderRadius: 6,
              padding: '8px 12px',
              background: '#f8fafc',
              fontSize: 12,
            }}
          >
            <summary style={{ cursor: 'pointer', fontWeight: 600 }}>
              Generated Config Header (<code>include/car_config.h</code>)
            </summary>
            <pre
              data-testid="header-preview"
              style={{
                marginTop: 8,
                padding: 8,
                background: '#0f172a',
                color: '#e2e8f0',
                borderRadius: 4,
                overflowX: 'auto',
                fontSize: 11,
              }}
            >
              {headerPreview}
            </pre>
          </details>
        </div>
      </div>
    </div>
  );
}
