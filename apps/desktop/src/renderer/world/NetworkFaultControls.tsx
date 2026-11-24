import type { NetFaults } from '@rcsim/sim-protocol';
import { useState, type FormEvent, type ReactNode } from 'react';
import { parseIpcError, type RcsimApi, type RunInfo } from '../../shared/ipc.ts';

export const MAX_LATENCY_US = 0xffff_ffff;
export const MAX_LOSS_PPM = 1_000_000;
export const MAX_LOSS_PERCENT = 100;

export const DEFAULT_NET_FAULTS: NetFaults = {
  latencyUs: 0,
  lossPpm: 0,
  dropout: false,
};

export interface NetworkFaultDraft {
  readonly latencyMs: string;
  readonly lossPercent: string;
  readonly dropout: boolean;
}

export const DEFAULT_NETWORK_FAULT_DRAFT: NetworkFaultDraft = {
  latencyMs: '0',
  lossPercent: '0',
  dropout: false,
};

export type ParseNetworkFaultResult =
  | { readonly ok: true; readonly faults: NetFaults }
  | { readonly ok: false; readonly error: string };

/** Whether a simulation run can currently accept `run.setNetFaults` updates. */
export function canApplyNetFaults(runState: RunInfo['state'] | null): boolean {
  return runState === 'running' || runState === 'paused';
}

function parseFiniteInput(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : null;
}

/**
 * Validates UI draft values (latency in ms, loss in %, dropout boolean) and
 * converts them to integer sim-protocol `NetFaults` (µs and ppm).
 */
export function parseNetworkFaultDraft(draft: NetworkFaultDraft): ParseNetworkFaultResult {
  const latencyMs = parseFiniteInput(draft.latencyMs);
  if (latencyMs === null || latencyMs < 0) {
    return { ok: false, error: 'Latency (ms) must be a non-negative number.' };
  }
  const latencyUs = Math.round(latencyMs * 1000);
  if (!Number.isInteger(latencyUs) || latencyUs < 0 || latencyUs > MAX_LATENCY_US) {
    return { ok: false, error: 'Latency (ms) exceeds the maximum supported delay.' };
  }

  const lossPercent = parseFiniteInput(draft.lossPercent);
  if (lossPercent === null || lossPercent < 0 || lossPercent > MAX_LOSS_PERCENT) {
    return { ok: false, error: 'Packet loss (%) must be between 0 and 100.' };
  }
  const lossPpm = Math.round(lossPercent * 10_000);
  if (!Number.isInteger(lossPpm) || lossPpm < 0 || lossPpm > MAX_LOSS_PPM) {
    return { ok: false, error: 'Packet loss (%) must be between 0 and 100.' };
  }

  return {
    ok: true,
    faults: {
      latencyUs: latencyUs === 0 ? 0 : latencyUs,
      lossPpm: lossPpm === 0 ? 0 : lossPpm,
      dropout: Boolean(draft.dropout),
    },
  };
}

/** Human-readable summary of applied `NetFaults` in UI units (ms and %). */
export function formatNetFaultsSummary(faults: NetFaults): string {
  if (faults.latencyUs === 0 && faults.lossPpm === 0 && !faults.dropout) {
    return 'no faults';
  }
  const ms = Number((faults.latencyUs / 1000).toFixed(3));
  const pct = Number((faults.lossPpm / 10_000).toFixed(4));
  const parts = [`${ms} ms`, `${pct}%`];
  if (faults.dropout) parts.push('dropout on');
  return parts.join(', ');
}

function isDefaultFaults(faults: NetFaults): boolean {
  return faults.latencyUs === 0 && faults.lossPpm === 0 && !faults.dropout;
}

export interface NetworkFaultControlsProps {
  readonly api?: RcsimApi;
  readonly runState: RunInfo['state'] | null;
  readonly runId?: string | null;
  readonly stepCount?: number;
}

/** 3D World toolbar strip for injecting sim-time network latency, packet loss, and dropout. */
export function NetworkFaultControls({
  api,
  runState,
  runId = null,
  stepCount = 0,
}: NetworkFaultControlsProps): ReactNode {
  const resolvedApi = api ?? window.rcsim;
  const canApply = canApplyNetFaults(runState);
  const runKey = canApply ? (runId ?? 'active') : 'inactive';

  const [prevRunKey, setPrevRunKey] = useState(runKey);
  const [prevRunState, setPrevRunState] = useState(runState);
  const [prevStepCount, setPrevStepCount] = useState(stepCount);

  const [draft, setDraft] = useState<NetworkFaultDraft>(DEFAULT_NETWORK_FAULT_DRAFT);
  const [applied, setApplied] = useState<NetFaults>(DEFAULT_NET_FAULTS);
  const [queuedForNextStep, setQueuedForNextStep] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  if (prevRunKey !== runKey) {
    setPrevRunKey(runKey);
    setPrevRunState(runState);
    setPrevStepCount(stepCount);
    setDraft(DEFAULT_NETWORK_FAULT_DRAFT);
    setApplied(DEFAULT_NET_FAULTS);
    setQueuedForNextStep(false);
    setError('');
  } else {
    if (prevRunState !== runState) {
      setPrevRunState(runState);
      if (runState === 'running' && queuedForNextStep) {
        setQueuedForNextStep(false);
      }
    }
    if (prevStepCount !== stepCount) {
      setPrevStepCount(stepCount);
      if (queuedForNextStep) {
        setQueuedForNextStep(false);
      }
    }
  }

  const isDefaultDraft =
    draft.latencyMs.trim() === '0' && draft.lossPercent.trim() === '0' && !draft.dropout;
  const hasActiveFaults = canApply && !isDefaultFaults(applied);

  const statusText =
    runState === 'starting'
      ? 'Starting simulation — faults available once active'
      : !canApply
        ? 'Start a simulation to apply network faults'
        : runState === 'paused'
          ? queuedForNextStep
            ? `Paused — queued for next step (${formatNetFaultsSummary(applied)})`
            : `Paused — edits apply on next step (${formatNetFaultsSummary(applied)})`
          : `Active — ${formatNetFaultsSummary(applied)}`;

  const handleApply = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (!canApply) {
      setError('Start a simulation before applying network faults.');
      return;
    }
    const parsed = parseNetworkFaultDraft(draft);
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    setSubmitting(true);
    setError('');
    try {
      await resolvedApi.run.setNetFaults(parsed.faults);
      setApplied(parsed.faults);
      setQueuedForNextStep(runState === 'paused');
    } catch (err) {
      setError(parseIpcError(err).message);
    } finally {
      setSubmitting(false);
    }
  };

  const handleReset = async (): Promise<void> => {
    setError('');
    if (!canApply) {
      setDraft(DEFAULT_NETWORK_FAULT_DRAFT);
      return;
    }
    setSubmitting(true);
    try {
      await resolvedApi.run.setNetFaults(DEFAULT_NET_FAULTS);
      setDraft(DEFAULT_NETWORK_FAULT_DRAFT);
      setApplied(DEFAULT_NET_FAULTS);
      setQueuedForNextStep(runState === 'paused');
    } catch (err) {
      setError(parseIpcError(err).message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      data-testid="network-fault-controls"
      aria-label="Network fault controls"
      style={{
        display: 'flex',
        flexDirection: 'column',
        background: '#131b24',
        borderBottom: '1px solid #2b3947',
        flexShrink: 0,
      }}
    >
      <form
        noValidate
        onSubmit={(event) => void handleApply(event)}
        style={{
          display: 'flex',
          flexWrap: 'nowrap',
          alignItems: 'center',
          gap: 10,
          minHeight: 34,
          padding: '5px 14px',
          fontSize: 12,
          overflowX: 'auto',
          overflowY: 'hidden',
          whiteSpace: 'nowrap',
        }}
      >
        <strong style={{ flexShrink: 0 }}>Network faults</strong>

        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
          <span>Latency (ms)</span>
          <input
            type="text"
            inputMode="decimal"
            aria-label="Network latency (ms)"
            data-testid="net-fault-latency-ms"
            disabled={submitting}
            value={draft.latencyMs}
            onChange={(event) => {
              setError('');
              setDraft((prev) => ({ ...prev, latencyMs: event.target.value }));
            }}
            style={{ width: 64, padding: '3px 6px' }}
          />
        </label>

        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
          <span>Loss (%)</span>
          <input
            type="text"
            inputMode="decimal"
            aria-label="Packet loss (%)"
            data-testid="net-fault-loss-percent"
            disabled={submitting}
            value={draft.lossPercent}
            onChange={(event) => {
              setError('');
              setDraft((prev) => ({ ...prev, lossPercent: event.target.value }));
            }}
            style={{ width: 58, padding: '3px 6px' }}
          />
        </label>

        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 5, flexShrink: 0 }}>
          <input
            type="checkbox"
            aria-label="Network dropout"
            data-testid="net-fault-dropout"
            disabled={submitting}
            checked={draft.dropout}
            onChange={(event) => {
              setError('');
              setDraft((prev) => ({ ...prev, dropout: event.target.checked }));
            }}
          />
          <span>Dropout</span>
        </label>

        <button
          type="submit"
          data-testid="net-fault-apply-btn"
          disabled={!canApply || submitting}
          style={{ flexShrink: 0 }}
        >
          Apply
        </button>

        <button
          type="button"
          data-testid="net-fault-reset-btn"
          disabled={submitting || (!canApply && isDefaultDraft && !error)}
          onClick={() => void handleReset()}
          style={{ flexShrink: 0 }}
        >
          Reset
        </button>

        <span
          data-testid="net-fault-status"
          style={{
            marginLeft: 'auto',
            flexShrink: 0,
            padding: '2px 8px',
            borderRadius: 4,
            border: `1px solid ${
              hasActiveFaults ? (applied.dropout ? '#ef4444' : '#f59e0b') : '#2b3947'
            }`,
            background: hasActiveFaults ? (applied.dropout ? '#3b1d24' : '#332815') : '#10171e',
            color: hasActiveFaults ? (applied.dropout ? '#fca5a5' : '#fcd34d') : '#9dafbe',
            fontSize: 11,
          }}
        >
          {statusText}
        </span>
      </form>

      {error ? (
        <div
          className="notice app-notice"
          role="alert"
          data-testid="net-fault-error"
          style={{ margin: '0 14px 6px' }}
        >
          <span>{error}</span>
          <button
            type="button"
            aria-label="Dismiss network fault error"
            onClick={() => setError('')}
          >
            ×
          </button>
        </div>
      ) : null}
    </div>
  );
}
