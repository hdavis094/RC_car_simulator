// @vitest-environment jsdom
import { createCatalog, defaultCatalog, exampleCar, generateCarConfigHeader } from '@rcsim/schema';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { createFakeRcsimApi } from '../../shared/fake-api.ts';
import { buildPreviewSceneData } from './CarPreview3D.tsx';
import { describeBehaviorParamsSchema } from './NewPartForm.tsx';
import { WorkbenchRoot } from './WorkbenchRoot.tsx';
import { useWorkbenchStore } from './workbench-store.ts';

afterEach(() => {
  cleanup();
});

describe('Workbench environment (P1-E)', () => {
  it('loads the example car from packages/schema and shows zero errors', async () => {
    const fake = createFakeRcsimApi();
    render(<WorkbenchRoot api={fake.api} />);

    await waitFor(() => {
      expect(fake.calls.some((c) => c.service === 'project' && c.method === 'readCar')).toBe(true);
    });

    expect(screen.getByTestId('wiring-summary-counts').textContent).toBe('0 errors, 0 warnings');
    expect(screen.getByTestId('workbench-wiring-badge').textContent).toBe('0 errors');
    expect(screen.getByText(/No wiring issues/i)).toBeTruthy();
    expect(useWorkbenchStore.getState().issues).toEqual([]);
  });

  it('assigning two parts to the same GPIO shows the conflict on both rows and clicking the issue focuses its row', async () => {
    const fake = createFakeRcsimApi();
    render(<WorkbenchRoot api={fake.api} />);

    await waitFor(() => {
      expect(screen.getByTestId('pin-row-steering-SIGNAL')).toBeTruthy();
    });

    // In exampleCar, esc.SIGNAL is on GPIO 26 and steering.SIGNAL is on GPIO 25.
    // Assign steering.SIGNAL to GPIO 26 as well.
    const steeringSelect = screen.getByLabelText('Target for steering.SIGNAL') as HTMLSelectElement;
    // Check that GPIO dropdown shows capabilities (ADC2, input-only, strapping, etc.)
    const optionTexts = Array.from(steeringSelect.options).map((o) => o.textContent ?? '');
    expect(
      optionTexts.some(
        (t) => t.includes('GPIO 35') && t.includes('ADC1') && t.includes('input-only'),
      ),
    ).toBe(true);
    expect(optionTexts.some((t) => t.includes('GPIO 0') && t.includes('strapping'))).toBe(true);

    fireEvent.change(steeringSelect, { target: { value: '26' } });

    await waitFor(() => {
      expect(screen.getByTestId('row-issue-esc-SIGNAL-pin-conflict')).toBeTruthy();
      expect(screen.getByTestId('row-issue-steering-SIGNAL-pin-conflict')).toBeTruthy();
    });

    const escIssue = screen.getByTestId('row-issue-esc-SIGNAL-pin-conflict');
    const steeringIssue = screen.getByTestId('row-issue-steering-SIGNAL-pin-conflict');
    expect(escIssue.getAttribute('data-severity')).toBe('error');
    expect(steeringIssue.getAttribute('data-severity')).toBe('error');
    expect(escIssue.textContent).toMatch(/GPIO 26 is used by esc\.SIGNAL, steering\.SIGNAL/);
    expect(steeringIssue.textContent).toMatch(/GPIO 26 is used by esc\.SIGNAL, steering\.SIGNAL/);

    // Clicking the issue in the summary list focuses its row
    const summaryButton = screen.getByTestId('wiring-issue-pin-conflict-0');
    fireEvent.click(summaryButton);

    const escRow = screen.getByTestId('pin-row-esc-SIGNAL');
    expect(escRow.getAttribute('data-focused')).toBe('true');
    expect(document.activeElement).toBe(escRow);
  });

  it('moving the battery divider to an ADC2 pin shows the Wi-Fi/ADC2 error', async () => {
    const fake = createFakeRcsimApi();
    render(<WorkbenchRoot api={fake.api} />);

    await waitFor(() => {
      expect(screen.getByTestId('pin-row-battery_sense-OUT')).toBeTruthy();
    });

    const dividerOutSelect = screen.getByLabelText(
      'Target for battery_sense.OUT',
    ) as HTMLSelectElement;
    expect(dividerOutSelect.value).toBe('35');

    // Move battery_sense.OUT to GPIO 27 (an ADC2 pin while Wi-Fi is enabled)
    fireEvent.change(dividerOutSelect, { target: { value: '27' } });

    await waitFor(() => {
      expect(screen.getByTestId('row-issue-battery_sense-OUT-adc2-wifi')).toBeTruthy();
    });

    const rowIssue = screen.getByTestId('row-issue-battery_sense-OUT-adc2-wifi');
    expect(rowIssue.getAttribute('data-severity')).toBe('error');
    expect(rowIssue.textContent).toMatch(
      /GPIO 27 is on ADC2, which is unavailable while Wi-Fi is on/,
    );
    expect(screen.getByTestId('wiring-issue-adc2-wifi-0').textContent).toMatch(/ADC2/);
  });

  it('a custom part created in the form round-trips through save and reload', async () => {
    const fake = createFakeRcsimApi();
    const { unmount } = render(<WorkbenchRoot api={fake.api} />);

    await waitFor(() => {
      expect(screen.getByTestId('catalog-groups')).toBeTruthy();
    });

    // Open the New Part form
    fireEvent.click(screen.getByRole('button', { name: 'New Part' }));
    expect(screen.getByTestId('new-part-form')).toBeTruthy();

    // Verify the behavior params form is generated from the Zod schema
    const distanceFields = describeBehaviorParamsSchema('distance-raycast').map((f) => f.key);
    expect(distanceFields).toEqual([
      'minRangeMm',
      'maxRangeMm',
      'beamAngleDeg',
      'rays',
      'noiseSigmaPct',
      'updateHz',
    ]);

    // Fill in custom part fields
    fireEvent.change(screen.getByLabelText('Part definition id'), {
      target: { value: 'sensor.custom-laser' },
    });
    fireEvent.change(screen.getByLabelText('Part name'), {
      target: { value: 'Custom Laser Ranger' },
    });
    fireEvent.change(screen.getByLabelText('Param maxRangeMm'), {
      target: { value: '3500' },
    });
    fireEvent.change(screen.getByLabelText('Param beamAngleDeg'), {
      target: { value: '12' },
    });

    // Save the custom part through the catalog IPC
    fireEvent.click(screen.getByRole('button', { name: 'Save Custom Part' }));

    await waitFor(() => {
      expect(fake.files.has('parts/sensor.custom-laser.json')).toBe(true);
      expect(screen.getByTestId('catalog-part-sensor.custom-laser')).toBeTruthy();
    });

    // Add the new custom part to the car with an explicit instance id
    fireEvent.change(screen.getByLabelText('New instance id'), {
      target: { value: 'laser_front' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add Custom Laser Ranger' }));

    await waitFor(() => {
      expect(screen.getByTestId('car-part-laser_front')).toBeTruthy();
    });

    // Wire the new part so we can also test saving the car with it
    fireEvent.change(screen.getByLabelText('Power source for laser_front.VCC'), {
      target: { value: 'esp32:3V3' },
    });
    fireEvent.change(screen.getByLabelText('Target for laser_front.TRIG'), {
      target: { value: '13' },
    });
    fireEvent.change(screen.getByLabelText('Target for laser_front.ECHO'), {
      target: { value: '34' },
    });

    // Save the car
    fireEvent.click(screen.getByRole('button', { name: /^Save/ }));

    await waitFor(() => {
      expect(screen.getByTestId('workbench-save-status')).toBeTruthy();
    });

    // Unmount and reload the Workbench from the same fake IPC
    unmount();
    render(<WorkbenchRoot api={fake.api} />);

    await waitFor(() => {
      expect(screen.getByTestId('catalog-part-sensor.custom-laser')).toBeTruthy();
      expect(screen.getByTestId('car-part-laser_front')).toBeTruthy();
    });

    // Inspect the reloaded custom part to confirm all fields round-tripped
    fireEvent.click(screen.getByTestId('car-part-laser_front'));
    const inspector = screen.getByTestId('part-inspector');
    expect(within(inspector).getByText('Custom Laser Ranger')).toBeTruthy();
    expect(within(inspector).getByText('3500')).toBeTruthy();
    expect(within(inspector).getByText('12')).toBeTruthy();
  });

  it('saving writes a header byte-identical to generateCarConfigHeader for the same car, and flags wiring errors when present', async () => {
    const fake = createFakeRcsimApi();
    render(<WorkbenchRoot api={fake.api} />);

    await waitFor(() => {
      expect(screen.getByTestId('pin-row-steering-SIGNAL')).toBeTruthy();
    });

    // Change steering.SIGNAL from GPIO 25 to GPIO 32 (valid pin, no conflict)
    fireEvent.change(screen.getByLabelText('Target for steering.SIGNAL'), {
      target: { value: '32' },
    });

    fireEvent.click(screen.getByRole('button', { name: /^Save/ }));

    await waitFor(() => {
      expect(screen.getByTestId('workbench-save-status').getAttribute('data-flagged')).toBe(
        'false',
      );
    });

    const currentCar = useWorkbenchStore.getState().car;
    const currentCatalog = createCatalog([], defaultCatalog);
    const expectedHeader = generateCarConfigHeader(currentCar, currentCatalog);
    expect(fake.files.get('include/car_config.h')).toBe(expectedHeader);

    // Now introduce a wiring error (conflict on GPIO 26) and verify saving is allowed but flagged
    fireEvent.change(screen.getByLabelText('Target for steering.SIGNAL'), {
      target: { value: '26' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^Save/ }));

    await waitFor(() => {
      expect(screen.getByTestId('workbench-save-status').getAttribute('data-flagged')).toBe('true');
    });
    expect(screen.getByTestId('workbench-save-status').textContent).toMatch(/wiring error/);
    expect(fake.files.get('include/car_config.h')).toBe(
      generateCarConfigHeader(useWorkbenchStore.getState().car, currentCatalog),
    );
  });

  it('supports editing placements, instance ids, and computes 3D preview boxes and distance-sensor beam cones', async () => {
    const fake = createFakeRcsimApi();
    render(<WorkbenchRoot api={fake.api} />);

    await waitFor(() => {
      expect(screen.getByTestId('placement-row-tof_left')).toBeTruthy();
    });

    // Update tof_left mount point, offset, and yaw
    fireEvent.change(screen.getByLabelText('Mount point for tof_left'), {
      target: { value: 'roof' },
    });
    fireEvent.change(screen.getByLabelText('Offset X for tof_left'), {
      target: { value: '15' },
    });
    fireEvent.change(screen.getByLabelText('Yaw for tof_left'), {
      target: { value: '10' },
    });

    const state = useWorkbenchStore.getState();
    const scene = buildPreviewSceneData(state.car, state.catalog);
    expect(scene.chassis?.dimensionsMm).toEqual({ width: 296, height: 214, length: 568 });

    const tofLeftPreview = scene.placedParts.find((p) => p.instanceId === 'tof_left');
    expect(tofLeftPreview?.mount).toBe('roof');
    // roof mount is (0, 200, 0) + offset (15, 0, 0) = (15, 200, 0)
    expect(tofLeftPreview?.positionMm).toEqual({ x: 15, y: 200, z: 0 });
    expect(tofLeftPreview?.yawDeg).toBe(10);
    expect(tofLeftPreview?.beam?.maxRangeMm).toBe(1200);
    expect(tofLeftPreview?.beam?.beamAngleDeg).toBe(25);

    // Rename instance id and verify uniqueness / C-identifier check
    const renameInput = screen.getByLabelText('Instance id for tof_left');
    fireEvent.change(renameInput, { target: { value: 'tof_roof' } });
    expect(useWorkbenchStore.getState().car.parts.some((p) => p.instanceId === 'tof_roof')).toBe(
      true,
    );

    // Removing a non-singleton part works, while controller and chassis have no remove button
    expect(screen.queryByLabelText('Remove esp32')).toBeNull();
    expect(screen.queryByLabelText('Remove chassis')).toBeNull();
    fireEvent.click(screen.getByLabelText('Remove tof_roof'));
    expect(useWorkbenchStore.getState().car.parts.some((p) => p.instanceId === 'tof_roof')).toBe(
      false,
    );
  });

  it('keeps exampleCar unmodified when cloning', () => {
    expect(exampleCar.name).toBe('Default car');
  });
});
