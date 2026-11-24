// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { createFakeRcsimApi } from '../../shared/fake-api.ts';
import { useEditorStore } from '../terminal/editor-state.ts';
import { resetWorkbenchStore, useWorkbenchStore } from '../workbench/workbench-store.ts';
import { App } from './App.tsx';
import { useEnvironmentStore } from './environment-store.ts';
import { useSessionStore } from './session.ts';

afterEach(() => {
  cleanup();
  resetWorkbenchStore();
  useEditorStore.getState().reset();
  useEnvironmentStore.getState().show('workbench');
  useSessionStore.getState().reset();
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
