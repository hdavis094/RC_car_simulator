import {
  carParts,
  type Car,
  type Catalog,
  type ControllerDefinition,
  type GpioDefinition,
  type Issue,
  type Part,
  type PinDefinition,
  type PinTarget,
} from '@rcsim/schema';
import { useRef, type ReactNode } from 'react';
import { NumericInput } from './NumericInput.tsx';
import { formatHex, useWorkbenchStore } from './workbench-store.ts';

/** Formats a controller GPIO with its capabilities for the GPIO dropdown. */
export function formatGpioOption(gpio: GpioDefinition): string {
  const caps: string[] = [];
  if (gpio.label) caps.push(gpio.label);
  if (gpio.adc1Channel !== undefined) caps.push('ADC1');
  if (gpio.adc2Channel !== undefined) caps.push('ADC2');
  if (gpio.inputOnly) caps.push('input-only');
  if (gpio.strapping) caps.push('strapping');
  if (gpio.flash) caps.push('flash');
  if (gpio.uart0) caps.push(`UART0 ${gpio.uart0.toUpperCase()}`);
  if (gpio.touchChannel !== undefined) caps.push('touch');
  return caps.length > 0 ? `GPIO ${gpio.gpio} (${caps.join(', ')})` : `GPIO ${gpio.gpio}`;
}

export function serializePinTarget(target: PinTarget | undefined): string {
  if (!target) return '';
  if ('gpio' in target) return String(target.gpio);
  return `${target.part}:${target.pin}`;
}

export function parsePinTarget(value: string): PinTarget | undefined {
  if (!value) return undefined;
  if (/^\d+$/.test(value)) {
    return { gpio: Number(value) };
  }
  const colonIdx = value.indexOf(':');
  if (colonIdx > 0) {
    return {
      part: value.slice(0, colonIdx),
      pin: value.slice(colonIdx + 1),
    };
  }
  return undefined;
}

export function rowKeyFor(instanceId: string, pinName: string): string {
  return `${instanceId}.${pinName}`;
}

/** Issues that belong inline to a given (part, pin) row. */
export function issuesForPinRow(
  issues: readonly Issue[],
  instanceId: string,
  pinName: string,
  target: PinTarget | undefined,
  isFirstPinOfPart: boolean,
): Issue[] {
  return issues.filter((issue) => {
    for (const ref of issue.refs) {
      if ('part' in ref) {
        if (ref.part === instanceId && ref.pin === pinName) return true;
        if (ref.part === instanceId && ref.pin === undefined && isFirstPinOfPart) return true;
      } else if (
        'gpio' in ref &&
        target &&
        'gpio' in target &&
        target.gpio === ref.gpio &&
        !issue.refs.some((r) => 'part' in r)
      ) {
        return true;
      }
    }
    return false;
  });
}

/** Resolves the primary row key to focus when clicking an issue in the summary list. */
export function primaryRowKeyForIssue(
  issue: Issue,
  car: Car,
  catalog: Catalog,
): string | undefined {
  for (const ref of issue.refs) {
    if ('part' in ref && ref.pin !== undefined) {
      return rowKeyFor(ref.part, ref.pin);
    }
  }
  for (const ref of issue.refs) {
    if ('part' in ref) {
      const part = carParts(car).find((p) => p.instanceId === ref.part);
      const def = part && catalog.get(part.partId);
      const firstPin = def?.pins[0];
      if (firstPin) return rowKeyFor(ref.part, firstPin.name);
    }
  }
  for (const ref of issue.refs) {
    if ('gpio' in ref) {
      for (const part of carParts(car)) {
        for (const [pinName, target] of Object.entries(part.pins ?? {})) {
          if ('gpio' in target && target.gpio === ref.gpio) {
            return rowKeyFor(part.instanceId, pinName);
          }
        }
      }
    }
  }
  return undefined;
}

interface PowerSourceOption {
  readonly value: string;
  readonly label: string;
}

function collectPowerSources(
  car: Car,
  catalog: Catalog,
  excludeInstanceId: string,
): PowerSourceOption[] {
  const options: PowerSourceOption[] = [];
  for (const part of carParts(car)) {
    if (part.instanceId === excludeInstanceId) continue;
    const def = catalog.get(part.partId);
    if (!def) continue;
    for (const pin of def.pins) {
      if (pin.kind !== 'power-out') continue;
      const vText =
        typeof pin.voltage === 'number'
          ? `${pin.voltage} V`
          : typeof pin.voltage === 'object'
            ? `${pin.voltage.min}–{pin.voltage.max} V`
            : '';
      const budgetText = pin.maxCurrentMa !== undefined ? `, ${pin.maxCurrentMa} mA` : '';
      const details = vText ? ` (${vText}${budgetText})` : '';
      options.push({
        value: `${part.instanceId}:${pin.name}`,
        label: `${part.instanceId}.${pin.name}${details}`,
      });
    }
  }
  return options;
}

function collectOtherPartPins(
  car: Car,
  catalog: Catalog,
  excludeInstanceId: string,
): PowerSourceOption[] {
  const options: PowerSourceOption[] = [];
  for (const part of carParts(car)) {
    if (part.instanceId === excludeInstanceId) continue;
    const def = catalog.get(part.partId);
    if (!def) continue;
    for (const pin of def.pins) {
      if (pin.kind === 'gnd') continue;
      options.push({
        value: `${part.instanceId}:${pin.name}`,
        label: `${part.instanceId}.${pin.name} (${pin.kind})`,
      });
    }
  }
  return options;
}

export function PinAssignmentTable(): ReactNode {
  const car = useWorkbenchStore((s) => s.car);
  const catalog = useWorkbenchStore((s) => s.catalog);
  const issues = useWorkbenchStore((s) => s.issues);
  const focusedRowKey = useWorkbenchStore((s) => s.focusedRowKey);
  const assignPin = useWorkbenchStore((s) => s.assignPin);
  const setI2cAddress = useWorkbenchStore((s) => s.setI2cAddress);
  const focusIssueRow = useWorkbenchStore((s) => s.focusIssueRow);
  const selectInstance = useWorkbenchStore((s) => s.selectInstance);

  const rowRefs = useRef<Map<string, HTMLTableRowElement>>(new Map());

  const controllerDef = catalog.get(car.controller.partId) as ControllerDefinition | undefined;
  const gpios: readonly GpioDefinition[] =
    controllerDef?.category === 'controller' ? controllerDef.gpios : [];

  const allParts = carParts(car);
  const errorCount = issues.filter((i) => i.severity === 'error').length;
  const warningCount = issues.filter((i) => i.severity === 'warning').length;

  const handleIssueClick = (issue: Issue) => {
    const key = primaryRowKeyForIssue(issue, car, catalog);
    if (!key) return;
    focusIssueRow(key);
    const el = rowRefs.current.get(key);
    if (el) {
      el.focus();
      if (typeof el.scrollIntoView === 'function') {
        el.scrollIntoView({ block: 'nearest' });
      }
    }
  };

  const renderTargetControl = (part: Part, pin: PinDefinition) => {
    const currentTarget = part.pins?.[pin.name];
    const currentValue = serializePinTarget(currentTarget);
    const powerSources = collectPowerSources(car, catalog, part.instanceId);
    const otherPins = collectOtherPartPins(car, catalog, part.instanceId);

    if (pin.kind === 'power-in') {
      return (
        <select
          aria-label={`Power source for ${part.instanceId}.${pin.name}`}
          value={currentValue}
          onChange={(e) => assignPin(part.instanceId, pin.name, parsePinTarget(e.target.value))}
          style={{
            fontSize: 12,
            padding: '3px 6px',
            borderRadius: 4,
            border: '1px solid #cbd5e1',
            width: '100%',
            maxWidth: 260,
          }}
        >
          <option value="">Unconnected</option>
          {powerSources.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
          {currentValue && !powerSources.some((o) => o.value === currentValue) && (
            <option value={currentValue}>{currentValue}</option>
          )}
        </select>
      );
    }

    if (pin.kind === 'gnd' || pin.kind === 'power-out') {
      if (!currentValue) {
        return (
          <span style={{ fontSize: 12, color: '#64748b' }}>
            {pin.kind === 'gnd' ? 'Common ground' : 'Power output rail'}
          </span>
        );
      }
    }

    return (
      <select
        aria-label={`Target for ${part.instanceId}.${pin.name}`}
        value={currentValue}
        onChange={(e) => assignPin(part.instanceId, pin.name, parsePinTarget(e.target.value))}
        style={{
          fontSize: 12,
          padding: '3px 6px',
          borderRadius: 4,
          border: '1px solid #cbd5e1',
          width: '100%',
          maxWidth: 260,
        }}
      >
        <option value="">Unconnected</option>
        <optgroup label="Controller GPIOs">
          {gpios.map((g) => (
            <option key={g.gpio} value={String(g.gpio)}>
              {formatGpioOption(g)}
            </option>
          ))}
        </optgroup>
        <optgroup label="Part pins">
          {otherPins.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </optgroup>
      </select>
    );
  };

  return (
    <section
      aria-label="Pin assignment"
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
        <h2 style={{ margin: 0, fontSize: 16 }}>Pin Assignments</h2>
        <div
          data-testid="wiring-summary-counts"
          style={{
            fontSize: 12,
            fontWeight: 600,
            color: errorCount > 0 ? '#b91c1c' : warningCount > 0 ? '#b45309' : '#15803d',
          }}
        >
          {errorCount === 0 && warningCount === 0
            ? '0 errors, 0 warnings'
            : `${errorCount} error(s), ${warningCount} warning(s)`}
        </div>
      </div>

      {/* Summary list of wiring rule issues */}
      <div
        aria-label="Wiring issues summary"
        data-testid="wiring-issues-summary"
        style={{ display: 'flex', flexDirection: 'column', gap: 4 }}
      >
        {issues.length === 0 ? (
          <div
            style={{
              padding: '6px 10px',
              borderRadius: 4,
              background: '#f0fdf4',
              border: '1px solid #bbf7d0',
              color: '#166534',
              fontSize: 12,
            }}
          >
            No wiring issues — ready to run.
          </div>
        ) : (
          issues.map((issue, idx) => {
            const isError = issue.severity === 'error';
            return (
              <button
                key={`${issue.rule}-${idx}-${issue.message}`}
                type="button"
                data-testid={`wiring-issue-${issue.rule}-${idx}`}
                data-severity={issue.severity}
                onClick={() => handleIssueClick(issue)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  textAlign: 'left',
                  padding: '6px 10px',
                  borderRadius: 4,
                  border: isError ? '1px solid #fca5a5' : '1px solid #fcd34d',
                  background: isError ? '#fef2f2' : '#fffbeb',
                  color: isError ? '#b91c1c' : '#b45309',
                  fontSize: 12,
                  cursor: 'pointer',
                }}
              >
                <span
                  style={{
                    fontWeight: 700,
                    textTransform: 'uppercase',
                    fontSize: 10,
                    padding: '1px 5px',
                    borderRadius: 3,
                    background: isError ? '#fee2e2' : '#fef3c7',
                  }}
                >
                  {issue.severity}
                </span>
                <code style={{ fontSize: 11 }}>{issue.rule}</code>
                <span>{issue.message}</span>
              </button>
            );
          })
        )}
      </div>

      <div style={{ overflowX: 'auto' }}>
        <table
          aria-label="Pin assignment table"
          style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}
        >
          <thead>
            <tr style={{ borderBottom: '2px solid #e2e8f0', textAlign: 'left', color: '#475569' }}>
              <th style={{ padding: '6px 8px' }}>Part</th>
              <th style={{ padding: '6px 8px' }}>Pin</th>
              <th style={{ padding: '6px 8px' }}>Kind</th>
              <th style={{ padding: '6px 8px' }}>Target (GPIO / Power Source)</th>
              <th style={{ padding: '6px 8px' }}>Wiring Issues</th>
            </tr>
          </thead>
          <tbody>
            {allParts.map((part) => {
              const def = catalog.get(part.partId);
              if (!def) {
                return (
                  <tr
                    key={part.instanceId}
                    data-testid={`pin-row-${part.instanceId}-unknown`}
                    style={{ borderBottom: '1px solid #e2e8f0', background: '#fef2f2' }}
                  >
                    <td style={{ padding: '6px 8px', fontFamily: 'monospace' }}>
                      {part.instanceId}
                    </td>
                    <td colSpan={4} style={{ padding: '6px 8px', color: '#b91c1c' }}>
                      Unknown part definition: {part.partId}
                    </td>
                  </tr>
                );
              }

              const hasI2c = 'i2c' in def && def.i2c !== undefined;
              const i2cInfo = hasI2c ? def.i2c : undefined;

              return def.pins.map((pin, pinIdx) => {
                const key = rowKeyFor(part.instanceId, pin.name);
                const target = part.pins?.[pin.name];
                const rowIssues = issuesForPinRow(
                  issues,
                  part.instanceId,
                  pin.name,
                  target,
                  pinIdx === 0,
                );
                const hasError = rowIssues.some((i) => i.severity === 'error');
                const hasWarning = !hasError && rowIssues.some((i) => i.severity === 'warning');
                const isFocused = focusedRowKey === key;

                return (
                  <tr
                    key={key}
                    ref={(el) => {
                      if (el) rowRefs.current.set(key, el);
                      else rowRefs.current.delete(key);
                    }}
                    tabIndex={-1}
                    data-testid={`pin-row-${part.instanceId}-${pin.name}`}
                    data-row-key={key}
                    data-focused={isFocused ? 'true' : 'false'}
                    onClick={() => selectInstance(part.instanceId)}
                    style={{
                      borderBottom: '1px solid #f1f5f9',
                      background: isFocused
                        ? '#dbeafe'
                        : hasError
                          ? '#fef2f2'
                          : hasWarning
                            ? '#fffbeb'
                            : '#ffffff',
                      outline: isFocused ? '2px solid #2563eb' : 'none',
                    }}
                  >
                    <td style={{ padding: '6px 8px', verticalAlign: 'top' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <code style={{ fontWeight: 600 }}>{part.instanceId}</code>
                        {pinIdx === 0 && i2cInfo && (
                          <label
                            style={{
                              display: 'inline-flex',
                              alignItems: 'center',
                              gap: 4,
                              fontSize: 11,
                              color: '#475569',
                            }}
                          >
                            I²C:
                            <NumericInput
                              ariaLabel={`I2C address for ${part.instanceId}`}
                              min={8}
                              max={119}
                              step={1}
                              placeholder={String(i2cInfo.defaultAddress)}
                              value={part.i2cAddress}
                              onChange={(val) => setI2cAddress(part.instanceId, Math.trunc(val))}
                              onClear={() => setI2cAddress(part.instanceId, undefined)}
                              style={{ width: 52, fontSize: 11, padding: '1px 4px' }}
                            />
                            <span>({formatHex(part.i2cAddress ?? i2cInfo.defaultAddress)})</span>
                          </label>
                        )}
                      </div>
                    </td>
                    <td
                      style={{
                        padding: '6px 8px',
                        fontFamily: 'monospace',
                        verticalAlign: 'top',
                      }}
                    >
                      {pin.name}
                      {pin.optional && (
                        <span style={{ fontSize: 10, color: '#64748b', marginLeft: 4 }}>(opt)</span>
                      )}
                    </td>
                    <td style={{ padding: '6px 8px', color: '#475569', verticalAlign: 'top' }}>
                      {pin.kind}
                    </td>
                    <td style={{ padding: '6px 8px', verticalAlign: 'top' }}>
                      {renderTargetControl(part, pin)}
                    </td>
                    <td style={{ padding: '6px 8px', verticalAlign: 'top' }}>
                      {rowIssues.length > 0 && (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                          {rowIssues.map((issue, idx) => {
                            const isErr = issue.severity === 'error';
                            return (
                              <div
                                key={`${issue.rule}-${idx}`}
                                data-testid={`row-issue-${part.instanceId}-${pin.name}-${issue.rule}`}
                                data-severity={issue.severity}
                                style={{
                                  color: isErr ? '#b91c1c' : '#b45309',
                                  fontWeight: 500,
                                  fontSize: 11,
                                }}
                              >
                                [{issue.severity.toUpperCase()}] {issue.message}
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </td>
                  </tr>
                );
              });
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
