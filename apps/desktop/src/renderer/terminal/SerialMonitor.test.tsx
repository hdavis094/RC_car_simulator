// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { createFakeRcsimApi } from '../../shared/fake-api.ts';
import { SerialMonitor } from './SerialMonitor.tsx';

afterEach(cleanup);

it('selects USB, opens at the chosen baud, routes TX and RX, and updates on removal', async () => {
  const fake = createFakeRcsimApi();
  const usb = '/dev/ttyUSB0';
  let receive: ((text: string) => void) | undefined;
  const hardware = {
    ...fake.api.hardware,
    listSerialPorts: async () => [usb],
    onSerialData(listener: (text: string) => void) {
      receive = listener;
      return () => {
        receive = undefined;
      };
    },
  };
  const flash = vi.fn(async () => {});
  render(<SerialMonitor api={{ ...fake.api, hardware }} flash={flash} flashDisabled={false} />);
  act(() => fake.emit.serial('Simulator boot\n'));
  expect(screen.getByLabelText('Serial output').textContent).toBe('Simulator boot\n');
  fireEvent.change(screen.getByLabelText('Source'), { target: { value: 'usb' } });
  await screen.findByRole('option', { name: usb });
  expect(screen.getByLabelText('Serial output').textContent).toBe('');
  fireEvent.change(screen.getByLabelText('Port'), { target: { value: usb } });
  fireEvent.change(screen.getByLabelText('Baud'), { target: { value: '57600' } });
  fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
  await screen.findByText('Connected', { exact: true });
  expect(fake.calls).toContainEqual({
    service: 'hardware',
    method: 'openSerial',
    args: [usb, 57600],
  });

  act(() => receive?.('USB boot\n'));
  expect(screen.getByLabelText('Serial output').textContent).toBe('USB boot\n');
  fireEvent.change(screen.getByLabelText('Serial send line'), { target: { value: 'ping' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  await waitFor(() =>
    expect(fake.calls).toContainEqual({
      service: 'hardware',
      method: 'writeSerial',
      args: ['ping\n'],
    }),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Flash to ESP32' }));
  expect(flash).toHaveBeenCalledWith(usb);

  await act(async () => {
    await hardware.closeSerial();
  });
  expect(screen.getByText('Disconnected', { exact: true })).toBeTruthy();
  expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Send' }).disabled).toBe(true);
  fireEvent.change(screen.getByLabelText('Source'), { target: { value: 'sim' } });
  expect(screen.getByLabelText('Serial output').textContent).toBe('Simulator boot\n');
});
