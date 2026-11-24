// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { ipcErrorMessage } from '../../shared/ipc.ts';
import { createFakeRcsimApi } from '../../shared/fake-api.ts';
import { useEditorStore } from '../terminal/editor-state.ts';
import { resetWorkbenchStore, useWorkbenchStore } from '../workbench/workbench-store.ts';
import { App } from './App.tsx';
import { useEnvironmentStore } from './environment-store.ts';
import { readPreferences, usePreferencesStore } from './preferences.ts';
import { useSessionStore } from './session.ts';

afterEach(() => {
  cleanup();
  resetWorkbenchStore();
  useEditorStore.getState().reset();
  useEnvironmentStore.getState().show('workbench');
  useSessionStore.getState().reset();
  window.localStorage.clear();
  usePreferencesStore.setState(readPreferences());
});

it('saves dirty Workbench and firmware edits before starting a simulation', async () => {
  const fake = createFakeRcsimApi();
  render(<App api={fake.api} />);
  await screen.findByText('Car project', { exact: false });
  await waitFor(() => expect(useWorkbenchStore.getState().loaded).toBe(true));
  await act(async () => {
    useWorkbenchStore.getState().setCarName('The saved car');
    await useEditorStore.getState().open(fake.api, 'src/main.cpp');
    useEditorStore.getState().edit('src/main.cpp', '// edited firmware\n');
  });
  expect(useWorkbenchStore.getState().dirty).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: '3D World' }));
  fireEvent.click(screen.getByTestId('run-play-pause-btn'));

  await waitFor(() =>
    expect(fake.calls.some(({ service, method }) => service === 'run' && method === 'start')).toBe(
      true,
    ),
  );
  const methods = fake.calls.map(({ service, method }) => `${service}.${method}`);
  expect(methods.indexOf('project.writeCar')).toBeGreaterThanOrEqual(0);
  expect(methods.indexOf('project.writeCar')).toBeLessThan(methods.indexOf('run.start'));
  expect(methods.indexOf('project.writeFile')).toBeGreaterThanOrEqual(0);
  expect(methods.indexOf('project.writeFile')).toBeLessThan(methods.indexOf('run.start'));
  expect(JSON.parse(fake.files.get('car.json') ?? '{}')).toMatchObject({ name: 'The saved car' });
  expect(fake.files.get('src/main.cpp')).toBe('// edited firmware\n');
});

it('offers first-run project guidance and recovery for a missing recent project', async () => {
  const fake = createFakeRcsimApi();
  fake.api.project.current = async () => null;
  const dir = '/missing/car';
  fake.api.project.recent = async () => [{ dir, name: 'Missing car' }];
  fake.api.project.open = async () => {
    throw new Error(ipcErrorMessage('not-found', 'ENOENT'));
  };
  render(<App api={fake.api} />);

  expect((await screen.findByRole('region', { name: 'Getting started' })).textContent).toContain(
    'starter firmware',
  );
  const recent = await screen.findByRole('combobox', { name: 'Recent projects' });
  fireEvent.change(recent, { target: { value: dir } });
  expect((await screen.findByRole('alert')).textContent).toContain(
    'Choose Open project to locate it',
  );
});

it('persists dock and simulation settings and uses them when starting a run', async () => {
  const fake = createFakeRcsimApi();
  render(<App api={fake.api} />);
  await screen.findByText('Car project', { exact: false });
  fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
  fireEvent.change(screen.getByLabelText('Panel position'), { target: { value: 'right' } });
  fireEvent.change(screen.getByLabelText('Initial simulation speed'), { target: { value: '0.5' } });
  fireEvent.change(screen.getByLabelText('Physics model'), { target: { value: '2' } });
  expect(screen.getByLabelText('Shared bottom panel').className).toContain('dock-right');
  expect(readPreferences()).toMatchObject({
    dockPosition: 'right',
    simulationSpeed: 0.5,
    physicsStage: 2,
  });

  fireEvent.click(screen.getByRole('button', { name: '3D World' }));
  expect((screen.getByLabelText('Simulation speed') as HTMLSelectElement).value).toBe('0.5');
  fireEvent.click(screen.getByTestId('run-play-pause-btn'));
  await waitFor(() =>
    expect(fake.calls).toContainEqual(
      expect.objectContaining({
        service: 'run',
        method: 'start',
        args: [expect.objectContaining({ speed: 0.5, physicsStage: 2 })],
      }),
    ),
  );
});
