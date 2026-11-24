/// <reference types="node" />
// @vitest-environment jsdom
/* eslint-disable no-restricted-imports */
import { trackLibrary } from '@rcsim/sim-core';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeRcsimApi } from '../../shared/fake-api.ts';
import { ipcErrorMessage } from '../../shared/ipc.ts';
import { useEnvironmentStore } from '../shell/environment-store.ts';
import { useSessionStore } from '../shell/session.ts';
import {
  DEFAULT_NET_FAULTS,
  MAX_LATENCY_US,
  MAX_LOSS_PPM,
  NetworkFaultControls,
  WorldRoot,
  canApplyNetFaults,
  formatNetFaultsSummary,
  parseNetworkFaultDraft,
} from './index.ts';

beforeEach(() => {
  useSessionStore.setState(useSessionStore.getInitialState());
  useEnvironmentStore.setState({ current: 'world' });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function createFakeWithRealTracks() {
  return createFakeRcsimApi({
    tracks: {
      oval: trackLibrary.load('oval'),
      technical: trackLibrary.load('technical'),
    },
  });
}

describe('NetworkFaultControls', () => {
  it('converts ms and % to integer µs and ppm and rejects invalid values', () => {
    expect(parseNetworkFaultDraft({ latencyMs: '0', lossPercent: '0', dropout: false })).toEqual({
      ok: true,
      faults: DEFAULT_NET_FAULTS,
    });
    expect(
      parseNetworkFaultDraft({ latencyMs: '12.5', lossPercent: '2.5', dropout: true }),
    ).toEqual({
      ok: true,
      faults: { latencyUs: 12_500, lossPpm: 25_000, dropout: true },
    });
    expect(
      parseNetworkFaultDraft({ latencyMs: '150.0004', lossPercent: '100', dropout: false }),
    ).toEqual({
      ok: true,
      faults: { latencyUs: 150_000, lossPpm: MAX_LOSS_PPM, dropout: false },
    });
    expect(
      parseNetworkFaultDraft({ latencyMs: '4294967.295', lossPercent: '0.01', dropout: false }),
    ).toEqual({
      ok: true,
      faults: { latencyUs: MAX_LATENCY_US, lossPpm: 100, dropout: false },
    });

    const invalidDrafts = [
      { latencyMs: '', lossPercent: '0', dropout: false },
      { latencyMs: '-1', lossPercent: '0', dropout: false },
      { latencyMs: 'abc', lossPercent: '0', dropout: false },
      { latencyMs: 'Infinity', lossPercent: '0', dropout: false },
      { latencyMs: '5000000', lossPercent: '0', dropout: false },
      { latencyMs: '0', lossPercent: '', dropout: false },
      { latencyMs: '0', lossPercent: '-0.1', dropout: false },
      { latencyMs: '0', lossPercent: '100.1', dropout: false },
      { latencyMs: '0', lossPercent: 'NaN', dropout: false },
    ];
    for (const draft of invalidDrafts) {
      expect(parseNetworkFaultDraft(draft).ok).toBe(false);
    }

    expect(canApplyNetFaults(null)).toBe(false);
    expect(canApplyNetFaults('starting')).toBe(false);
    expect(canApplyNetFaults('ended')).toBe(false);
    expect(canApplyNetFaults('running')).toBe(true);
    expect(canApplyNetFaults('paused')).toBe(true);
    expect(formatNetFaultsSummary(DEFAULT_NET_FAULTS)).toBe('no faults');
    expect(formatNetFaultsSummary({ latencyUs: 25_500, lossPpm: 125_000, dropout: true })).toBe(
      '25.5 ms, 12.5%, dropout on',
    );
  });

  it('shows availability status, validates inputs before IPC, resets cleanly, and reports IPC errors', async () => {
    const fake = createFakeWithRealTracks();
    const { rerender } = render(
      <NetworkFaultControls api={fake.api} runState={null} runId={null} />,
    );

    expect(screen.getByTestId('net-fault-status').textContent).toContain(
      'Start a simulation to apply network faults',
    );
    expect((screen.getByTestId('net-fault-apply-btn') as HTMLButtonElement).disabled).toBe(true);

    rerender(<NetworkFaultControls api={fake.api} runState="starting" runId="run-1" />);
    expect(screen.getByTestId('net-fault-status').textContent).toContain('Starting simulation');
    expect((screen.getByTestId('net-fault-apply-btn') as HTMLButtonElement).disabled).toBe(true);

    // Start an active run in fake API and switch component to running
    await fake.api.run.start({
      world: { schemaVersion: 1, name: 'Oval', trackId: 'oval', seed: 1, obstacles: [] },
      seed: 1,
    });
    rerender(<NetworkFaultControls api={fake.api} runState="running" runId="run-1" />);
    expect((screen.getByTestId('net-fault-apply-btn') as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByTestId('net-fault-status').textContent).toContain('Active — no faults');

    // Invalid value is caught locally and does not invoke IPC
    fireEvent.change(screen.getByTestId('net-fault-loss-percent'), { target: { value: '120' } });
    fireEvent.click(screen.getByTestId('net-fault-apply-btn'));
    expect(screen.getByTestId('net-fault-error').textContent).toContain('between 0 and 100');
    expect(
      fake.calls.filter((c) => c.service === 'run' && c.method === 'setNetFaults'),
    ).toHaveLength(0);

    // Valid values convert units and call run.setNetFaults
    fireEvent.change(screen.getByTestId('net-fault-latency-ms'), { target: { value: '45.5' } });
    fireEvent.change(screen.getByTestId('net-fault-loss-percent'), { target: { value: '12.5' } });
    fireEvent.click(screen.getByTestId('net-fault-dropout'));
    fireEvent.click(screen.getByTestId('net-fault-apply-btn'));

    await waitFor(() => {
      expect(screen.getByTestId('net-fault-status').textContent).toContain(
        'Active — 45.5 ms, 12.5%, dropout on',
      );
    });
    const applyCalls = fake.calls.filter((c) => c.service === 'run' && c.method === 'setNetFaults');
    expect(applyCalls).toHaveLength(1);
    expect(applyCalls[0]?.args[0]).toEqual({
      latencyUs: 45_500,
      lossPpm: 125_000,
      dropout: true,
    });

    // IPC error is reported and does not overwrite applied state
    const setSpy = vi
      .spyOn(fake.api.run, 'setNetFaults')
      .mockRejectedValueOnce(new Error(ipcErrorMessage('invalid', 'Host rejected fault settings')));
    fireEvent.change(screen.getByTestId('net-fault-latency-ms'), { target: { value: '90' } });
    fireEvent.click(screen.getByTestId('net-fault-apply-btn'));

    await waitFor(() => {
      expect(screen.getByTestId('net-fault-error').textContent).toContain(
        'Host rejected fault settings',
      );
    });
    expect(screen.getByTestId('net-fault-status').textContent).toContain(
      'Active — 45.5 ms, 12.5%, dropout on',
    );
    setSpy.mockRestore();

    // Reset clears inputs, clears error, and sends zeroed NetFaults
    fireEvent.click(screen.getByTestId('net-fault-reset-btn'));
    await waitFor(() => {
      expect(screen.getByTestId('net-fault-status').textContent).toContain('Active — no faults');
    });
    expect((screen.getByTestId('net-fault-latency-ms') as HTMLInputElement).value).toBe('0');
    expect((screen.getByTestId('net-fault-loss-percent') as HTMLInputElement).value).toBe('0');
    expect((screen.getByTestId('net-fault-dropout') as HTMLInputElement).checked).toBe(false);
    expect(screen.queryByTestId('net-fault-error')).toBeNull();
    const afterReset = fake.calls.filter((c) => c.service === 'run' && c.method === 'setNetFaults');
    expect(afterReset.at(-1)?.args[0]).toEqual(DEFAULT_NET_FAULTS);
  });

  it('integrates with WorldRoot for paused application, step transition, and reset on stop', async () => {
    const fake = createFakeWithRealTracks();
    render(<WorldRoot api={fake.api} />);

    // Initially idle
    expect((screen.getByTestId('net-fault-apply-btn') as HTMLButtonElement).disabled).toBe(true);

    // Start run, then pause
    fireEvent.click(screen.getByTestId('run-play-pause-btn'));
    await waitFor(() => {
      expect(screen.getByTestId('run-play-pause-btn').textContent).toBe('Pause');
    });
    fireEvent.click(screen.getByTestId('run-play-pause-btn'));
    await waitFor(() => {
      expect(screen.getByTestId('run-play-pause-btn').textContent).toBe('Resume');
    });

    expect(screen.getByTestId('net-fault-status').textContent).toContain(
      'Paused — edits apply on next step',
    );

    // Apply while paused -> queued for next step
    fireEvent.change(screen.getByTestId('net-fault-latency-ms'), { target: { value: '20' } });
    fireEvent.change(screen.getByTestId('net-fault-loss-percent'), { target: { value: '5' } });
    fireEvent.click(screen.getByTestId('net-fault-apply-btn'));

    await waitFor(() => {
      expect(screen.getByTestId('net-fault-status').textContent).toContain(
        'Paused — queued for next step (20 ms, 5%)',
      );
    });
    expect(
      fake.calls.filter((c) => c.service === 'run' && c.method === 'setNetFaults').at(-1)?.args[0],
    ).toEqual({
      latencyUs: 20_000,
      lossPpm: 50_000,
      dropout: false,
    });

    // Stepping clears the queued state while preserving the applied summary
    fireEvent.click(screen.getByTestId('run-step-btn'));
    await waitFor(() => {
      expect(screen.getByTestId('net-fault-status').textContent).toContain(
        'Paused — edits apply on next step (20 ms, 5%)',
      );
    });

    // Stopping resets the fault controls back to idle defaults
    fireEvent.click(screen.getByTestId('run-stop-btn'));
    await waitFor(() => {
      expect(screen.getByTestId('net-fault-status').textContent).toContain(
        'Start a simulation to apply network faults',
      );
    });
    expect((screen.getByTestId('net-fault-latency-ms') as HTMLInputElement).value).toBe('0');
    expect((screen.getByTestId('net-fault-loss-percent') as HTMLInputElement).value).toBe('0');
    expect((screen.getByTestId('net-fault-dropout') as HTMLInputElement).checked).toBe(false);
  });
});
