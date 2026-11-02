// @vitest-environment jsdom
import {
  SCHEMA_VERSION,
  createCatalog,
  defaultCatalog,
  exampleCar,
  generateCarConfigHeader,
  type PartDefinition,
} from '@rcsim/schema';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFakeRcsimApi } from '../../shared/fake-api.ts';
import { buildPreviewSceneData } from './CarPreview3D.tsx';
import { defaultPinsForTemplate, describeBehaviorParamsSchema } from './NewPartForm.tsx';
import { WorkbenchRoot } from './WorkbenchRoot.tsx';
import { resetWorkbenchStore, useWorkbenchStore } from './workbench-store.ts';

beforeEach(() => {
  resetWorkbenchStore();
});

afterEach(() => {
  cleanup();
});

describe('Workbench environment (P1-E)', () => {
  it('loads the example car from packages/schema and shows zero errors', async () => {
    // Store starts unloaded with no parts before mount
    expect(useWorkbenchStore.getState().loaded).toBe(false);
    expect(useWorkbenchStore.getState().car.parts).toEqual([]);

    const fake = createFakeRcsimApi();
    render(<WorkbenchRoot api={fake.api} />);

    await waitFor(() => {
      expect(fake.calls.some((c) => c.service === 'project' && c.method === 'readCar')).toBe(true);
      expect(useWorkbenchStore.getState().loaded).toBe(true);
    });

    expect(useWorkbenchStore.getState().car.parts.length).toBe(exampleCar.parts.length);
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

    // Rejects shadowing a built-in part id
    fireEvent.change(screen.getByLabelText('Part definition id'), {
      target: { value: 'sensor.hc-sr04' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save Custom Part' }));
    await waitFor(() => {
      expect(screen.getByTestId('new-part-errors').textContent).toMatch(/already in the catalog/i);
    });

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

    // Re-opening the form shows reset default values
    fireEvent.click(screen.getByRole('button', { name: 'New Part' }));
    expect((screen.getByLabelText('Part definition id') as HTMLInputElement).value).toBe(
      'sensor.custom-ranger',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

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

    // Assert the fake's car.json on disk actually contains laser_front
    const savedCarRaw = fake.files.get('car.json');
    expect(savedCarRaw).toBeDefined();
    expect(savedCarRaw).toContain('"laser_front"');
    expect(savedCarRaw).toContain('"sensor.custom-laser"');

    // Unmount, reset the Zustand singleton store, and reload from the same fake IPC
    unmount();
    resetWorkbenchStore();
    expect(useWorkbenchStore.getState().car.parts).toEqual([]);

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

  it('New Part form covers all controller GPIO fields, chassis mount points and CoG, pin fields, and IMU defaults', async () => {
    const fake = createFakeRcsimApi();
    render(<WorkbenchRoot api={fake.api} />);

    await waitFor(() => {
      expect(screen.getByTestId('catalog-groups')).toBeTruthy();
    });

    // Verify IMU default pins are VCC, SDA, SCL, GND
    expect(defaultPinsForTemplate('imu').map((p) => `${p.name}:${p.kind}`)).toEqual([
      'VCC:power-in',
      'SDA:i2c-sda',
      'SCL:i2c-scl',
      'GND:gnd',
    ]);

    // 1. Controller category with full GPIO fields and pin fields
    fireEvent.click(screen.getByRole('button', { name: 'New Part' }));
    fireEvent.change(screen.getByLabelText('Part category'), {
      target: { value: 'controller' },
    });
    fireEvent.change(screen.getByLabelText('Part definition id'), {
      target: { value: 'controller.custom-mcu' },
    });
    fireEvent.change(screen.getByLabelText('Part name'), {
      target: { value: 'Custom MCU' },
    });

    // Uncheck default strapping on GPIO 0 and edit all GPIO fields
    const strapping0 = screen.getByLabelText('Controller GPIO strapping 0') as HTMLInputElement;
    expect(strapping0.checked).toBe(true);
    fireEvent.click(strapping0);
    expect(strapping0.checked).toBe(false);

    fireEvent.change(screen.getByLabelText('Controller GPIO label 0'), {
      target: { value: 'BOOT' },
    });
    fireEvent.change(screen.getByLabelText('Controller GPIO adc1Channel 0'), {
      target: { value: '4' },
    });
    fireEvent.change(screen.getByLabelText('Controller GPIO adc2Channel 0'), {
      target: { value: '1' },
    });
    fireEvent.change(screen.getByLabelText('Controller GPIO touchChannel 0'), {
      target: { value: '2' },
    });
    fireEvent.change(screen.getByLabelText('Controller GPIO uart0 0'), {
      target: { value: 'tx' },
    });
    fireEvent.click(screen.getByLabelText('Controller GPIO inputOnly 0'));
    fireEvent.click(screen.getByLabelText('Controller GPIO flash 0'));

    // Edit Pin 0 (5V, power-in): description
    fireEvent.change(screen.getByLabelText('Pin 0 description'), {
      target: { value: 'Main 5V input' },
    });

    // Edit Pin 1 (3V3, power-out): voltage mode 'range'
    fireEvent.change(screen.getByLabelText('Pin 1 voltage mode'), {
      target: { value: 'range' },
    });
    fireEvent.change(screen.getByLabelText('Pin 1 voltage min'), {
      target: { value: '3.2' },
    });
    fireEvent.change(screen.getByLabelText('Pin 1 voltage max'), {
      target: { value: '3.4' },
    });

    // Add an input pin (Pin 3, digital-in) with voltage mode 'supply' and maxInputV
    fireEvent.click(screen.getByRole('button', { name: 'Add Pin' }));
    fireEvent.change(screen.getByLabelText('Pin 3 voltage mode'), {
      target: { value: 'supply' },
    });
    fireEvent.change(screen.getByLabelText('Pin 3 maxInputV'), {
      target: { value: '6.0' },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Save Custom Part' }));
    await waitFor(() => {
      expect(fake.files.has('parts/controller.custom-mcu.json')).toBe(true);
    });
    const savedController = JSON.parse(
      fake.files.get('parts/controller.custom-mcu.json')!,
    ) as PartDefinition;
    expect(savedController.category).toBe('controller');
    if (savedController.category === 'controller') {
      expect(savedController.gpios[0]).toEqual({
        gpio: 0,
        label: 'BOOT',
        adc1Channel: 4,
        adc2Channel: 1,
        touchChannel: 2,
        uart0: 'tx',
        inputOnly: true,
        flash: true,
      });
      expect(savedController.pins[0]).toMatchObject({
        name: '5V',
        description: 'Main 5V input',
      });
      expect(savedController.pins[1]).toMatchObject({
        name: '3V3',
        voltage: { min: 3.2, max: 3.4 },
      });
      expect(savedController.pins[3]).toMatchObject({
        name: 'PIN_4',
        kind: 'digital-in',
        voltage: 'supply',
        maxInputV: 6,
      });
    }

    // 2. Chassis category with CoG X/Y/Z and mount point add/edit/remove
    fireEvent.click(screen.getByRole('button', { name: 'New Part' }));
    fireEvent.change(screen.getByLabelText('Part category'), {
      target: { value: 'chassis' },
    });
    fireEvent.change(screen.getByLabelText('Part definition id'), {
      target: { value: 'chassis.custom-deck' },
    });
    fireEvent.change(screen.getByLabelText('Part name'), {
      target: { value: 'Custom Deck Chassis' },
    });
    fireEvent.change(screen.getByLabelText('CoG X mm'), { target: { value: '5' } });
    fireEvent.change(screen.getByLabelText('CoG Y mm'), { target: { value: '75' } });
    fireEvent.change(screen.getByLabelText('CoG Z mm'), { target: { value: '-10' } });

    // Edit mount point 0 position, yaw, pitch
    fireEvent.change(screen.getByLabelText('Mount point id 0'), {
      target: { value: 'nose' },
    });
    fireEvent.change(screen.getByLabelText('Mount point 0 X mm'), {
      target: { value: '12' },
    });
    fireEvent.change(screen.getByLabelText('Mount point 0 Y mm'), {
      target: { value: '45' },
    });
    fireEvent.change(screen.getByLabelText('Mount point 0 Z mm'), {
      target: { value: '-180' },
    });
    fireEvent.change(screen.getByLabelText('Mount point 0 yaw deg'), {
      target: { value: '-15' },
    });
    fireEvent.change(screen.getByLabelText('Mount point 0 pitch deg'), {
      target: { value: '5' },
    });

    // Add a second mount point and a third, then remove the third
    fireEvent.click(screen.getByRole('button', { name: 'Add Mount Point' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add Mount Point' }));
    expect(screen.getByLabelText('Mount point id 2')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Remove mount point 2'));
    expect(screen.queryByLabelText('Mount point id 2')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Save Custom Part' }));
    await waitFor(() => {
      expect(fake.files.has('parts/chassis.custom-deck.json')).toBe(true);
    });
    const savedChassis = JSON.parse(
      fake.files.get('parts/chassis.custom-deck.json')!,
    ) as PartDefinition;
    expect(savedChassis.category).toBe('chassis');
    if (savedChassis.category === 'chassis') {
      expect(savedChassis.centreOfGravityMm).toEqual({ x: 5, y: 75, z: -10 });
      expect(savedChassis.mountPoints).toHaveLength(2);
      expect(savedChassis.mountPoints[0]).toEqual({
        id: 'nose',
        positionMm: { x: 12, y: 45, z: -180 },
        yawDeg: -15,
        pitchDeg: 5,
      });
    }
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

  it('supports typing instance ids character-by-character without losing focus, rewrites references on rename, and cleans up dangling references on remove', async () => {
    const user = userEvent.setup();
    const fake = createFakeRcsimApi();
    render(<WorkbenchRoot api={fake.api} />);

    await waitFor(() => {
      expect(screen.getByTestId('placement-row-tof_left')).toBeTruthy();
    });

    // Type negative numbers into placement inputs (-25 offset X and -15 yaw)
    const offsetXInput = screen.getByLabelText('Offset X for tof_left') as HTMLInputElement;
    await user.clear(offsetXInput);
    await user.type(offsetXInput, '-25');
    expect(offsetXInput.value).toBe('-25');

    const yawInput = screen.getByLabelText('Yaw for tof_left') as HTMLInputElement;
    await user.clear(yawInput);
    await user.type(yawInput, '-15');
    expect(yawInput.value).toBe('-15');

    fireEvent.change(screen.getByLabelText('Mount point for tof_left'), {
      target: { value: 'roof' },
    });

    // Clear the optional I2C address for tof_left and verify it clears to undefined rather than 0
    const tofLeftAddrInput = screen.getByLabelText('I2C address for tof_left') as HTMLInputElement;
    await user.clear(tofLeftAddrInput);
    expect(tofLeftAddrInput.value).toBe('');
    expect(
      useWorkbenchStore.getState().car.parts.find((p) => p.instanceId === 'tof_left')?.i2cAddress,
    ).toBeUndefined();

    const state = useWorkbenchStore.getState();
    const scene = buildPreviewSceneData(state.car, state.catalog);
    expect(scene.chassis?.dimensionsMm).toEqual({ width: 296, height: 214, length: 568 });

    const tofLeftPreview = scene.placedParts.find((p) => p.instanceId === 'tof_left');
    expect(tofLeftPreview?.mount).toBe('roof');
    expect(tofLeftPreview?.positionMm).toEqual({ x: -25, y: 200, z: 0 });
    expect(tofLeftPreview?.yawDeg).toBe(-15);
    expect(tofLeftPreview?.beam?.maxRangeMm).toBe(1200);
    expect(tofLeftPreview?.beam?.beamAngleDeg).toBe(25);

    // Rename battery -> main_pack using user-event character-by-character typing.
    // In exampleCar, regulator.pins.VIN, esc.pins['BATT+'], and battery_sense.pins.IN reference { part: 'battery', pin: 'BAT+' }.
    const batteryInput = screen.getByLabelText('Instance id for battery') as HTMLInputElement;
    await user.clear(batteryInput);
    await user.type(batteryInput, 'main_pack');

    // While still focused before Enter/blur, the input retains focus and has not remounted
    expect(document.activeElement).toBe(batteryInput);
    expect(batteryInput.value).toBe('main_pack');
    expect(useWorkbenchStore.getState().car.parts.some((p) => p.instanceId === 'battery')).toBe(
      true,
    );

    // Commit on Enter
    await user.keyboard('{Enter}');
    expect(useWorkbenchStore.getState().car.parts.some((p) => p.instanceId === 'main_pack')).toBe(
      true,
    );

    // Verify all { part: 'battery', pin: 'BAT+' } references in pins were rewritten to 'main_pack'
    const afterRename = useWorkbenchStore.getState().car;
    const regulator = afterRename.parts.find((p) => p.instanceId === 'regulator');
    const divider = afterRename.parts.find((p) => p.instanceId === 'battery_sense');
    expect(regulator?.pins?.['VIN']).toEqual({ part: 'main_pack', pin: 'BAT+' });
    expect(divider?.pins?.['IN']).toEqual({ part: 'main_pack', pin: 'BAT+' });

    // Removing main_pack cleans up dangling references in regulator.pins and battery_sense.pins
    fireEvent.click(screen.getByLabelText('Remove main_pack'));
    const afterRemove = useWorkbenchStore.getState().car;
    expect(afterRemove.parts.some((p) => p.instanceId === 'main_pack')).toBe(false);
    expect(
      afterRemove.parts.find((p) => p.instanceId === 'regulator')?.pins?.['VIN'],
    ).toBeUndefined();
    expect(
      afterRemove.parts.find((p) => p.instanceId === 'battery_sense')?.pins?.['IN'],
    ).toBeUndefined();
  });

  it('preserves unsaved edits across unmount and remount (tab switch) and prompts on external car.json changes while dirty', async () => {
    const fake = createFakeRcsimApi();
    const { unmount } = render(<WorkbenchRoot api={fake.api} />);

    await waitFor(() => {
      expect(useWorkbenchStore.getState().loaded).toBe(true);
    });

    // Edit the car name so store becomes dirty
    fireEvent.change(screen.getByLabelText('Car name'), {
      target: { value: 'Unsaved Track Car' },
    });
    expect(useWorkbenchStore.getState().dirty).toBe(true);

    // Simulate switching away to Terminal and back to Workbench (unmount + remount without store reset)
    unmount();
    render(<WorkbenchRoot api={fake.api} />);

    // Unsaved edit is preserved
    expect((screen.getByLabelText('Car name') as HTMLInputElement).value).toBe('Unsaved Track Car');
    expect(useWorkbenchStore.getState().dirty).toBe(true);

    // Simulate an external change to car.json while dirty
    const externallyEditedCar = { ...exampleCar, name: 'External Disk Car' };
    await act(async () => {
      await fake.api.project.writeCar(externallyEditedCar);
    });

    await waitFor(() => {
      expect(screen.getByTestId('workbench-external-change')).toBeTruthy();
    });
    // Store keeps local unsaved edits until user chooses
    expect(useWorkbenchStore.getState().car.name).toBe('Unsaved Track Car');

    // Clicking "Keep mine" dismisses the banner and preserves local edits
    fireEvent.click(screen.getByRole('button', { name: 'Keep mine' }));
    expect(screen.queryByTestId('workbench-external-change')).toBeNull();
    expect(useWorkbenchStore.getState().car.name).toBe('Unsaved Track Car');

    // Trigger another external edit and click "Reload from disk"
    await act(async () => {
      await fake.api.project.writeCar({ ...exampleCar, name: 'Second External Car' });
    });
    await waitFor(() => {
      expect(screen.getByTestId('workbench-external-change')).toBeTruthy();
    });
    fireEvent.click(screen.getByRole('button', { name: 'Reload from disk' }));

    await waitFor(() => {
      expect(useWorkbenchStore.getState().car.name).toBe('Second External Car');
      expect(useWorkbenchStore.getState().dirty).toBe(false);
    });
  });

  it('refuses to save over a broken car.json on load failure, displays raw contents, and allows starting from the example car', async () => {
    const fake = createFakeRcsimApi();
    const brokenRaw = '{ "name": "Broken Car", invalid json ';
    fake.files.set('car.json', brokenRaw);

    render(<WorkbenchRoot api={fake.api} />);

    await waitFor(() => {
      expect(screen.getByTestId('workbench-load-error')).toBeTruthy();
    });

    expect(screen.getByTestId('workbench-load-error-raw').textContent).toBe(brokenRaw);
    const saveButton = screen.getByRole('button', { name: /^Save/ }) as HTMLButtonElement;
    expect(saveButton.disabled).toBe(true);

    // Attempting saveCar directly also refuses to overwrite the user's broken car.json
    const saved = await useWorkbenchStore.getState().saveCar();
    expect(saved).toBe(false);
    expect(fake.files.get('car.json')).toBe(brokenRaw);

    // Explicit recovery action loads exampleCar and enables Save
    fireEvent.click(screen.getByRole('button', { name: 'Start from the example car' }));
    expect(useWorkbenchStore.getState().loadError).toBeNull();
    expect(useWorkbenchStore.getState().loaded).toBe(true);
    expect(useWorkbenchStore.getState().car.name).toBe(exampleCar.name);
    expect((screen.getByRole('button', { name: /^Save/ }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  it('reports save failure when writeCar fails and keeps dirty state', async () => {
    const fake = createFakeRcsimApi();
    const failingApi = {
      ...fake.api,
      project: {
        ...fake.api.project,
        writeCar: () => Promise.reject(new Error('Disk full')),
      },
    };

    render(<WorkbenchRoot api={failingApi} />);

    await waitFor(() => {
      expect(useWorkbenchStore.getState().loaded).toBe(true);
    });

    fireEvent.change(screen.getByLabelText('Car name'), {
      target: { value: 'Will Fail Save' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^Save/ }));

    await waitFor(() => {
      expect(screen.getByTestId('workbench-save-status').textContent).toMatch(/Disk full/);
    });
    expect(useWorkbenchStore.getState().saveStatus?.ok).toBe(false);
    expect(useWorkbenchStore.getState().dirty).toBe(true);
  });

  it('links only http: and https: datasheet URLs and renders unsafe protocols as plain text', async () => {
    const fake = createFakeRcsimApi();
    const unsafePart: PartDefinition = {
      schemaVersion: SCHEMA_VERSION,
      id: 'sensor.unsafe-links',
      name: 'Unsafe Links Sensor',
      category: 'sensor',
      massG: 5,
      dimensionsMm: { width: 10, height: 10, length: 10 },
      electrical: {
        supplyV: { min: 3, max: 5 },
        logicLevelV: 3.3,
        currentMa: { typical: 5, peak: 10 },
      },
      pins: [
        { name: 'VCC', kind: 'power-in' },
        { name: 'GND', kind: 'gnd' },
      ],
      behavior: {
        template: 'distance-raycast',
        params: {
          minRangeMm: 20,
          maxRangeMm: 1000,
          beamAngleDeg: 15,
          rays: 3,
          noiseSigmaPct: 1,
          updateHz: 20,
        },
      },
      sources: [
        'https://example.com/safe-datasheet.pdf',
        'javascript:alert(1)',
        'file:///etc/passwd',
      ],
    };
    await fake.api.catalog.saveCustomPart(unsafePart);

    render(<WorkbenchRoot api={fake.api} />);

    await waitFor(() => {
      expect(screen.getByTestId('catalog-part-sensor.unsafe-links')).toBeTruthy();
    });

    fireEvent.click(screen.getByTestId('catalog-part-sensor.unsafe-links'));
    const datasheets = screen.getByTestId('inspector-datasheets');
    const links = within(datasheets).getAllByRole('link') as HTMLAnchorElement[];
    expect(links.map((a) => a.getAttribute('href'))).toEqual([
      'https://example.com/safe-datasheet.pdf',
    ]);
    expect(within(datasheets).getByText('javascript:alert(1)').tagName).toBe('SPAN');
    expect(within(datasheets).getByText('file:///etc/passwd').tagName).toBe('SPAN');
  });

  it('keeps exampleCar unmodified when cloning', () => {
    expect(exampleCar.name).toBe('Default car');
  });
});
