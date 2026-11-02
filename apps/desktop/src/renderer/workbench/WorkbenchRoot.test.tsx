// @vitest-environment jsdom
import {
  SCHEMA_VERSION,
  defaultCatalog,
  exampleCar,
  generateCarConfigHeader,
  type Car,
  type PartDefinition,
} from '@rcsim/schema';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CatalogListing, RcsimApi } from '../../shared/ipc.ts';
import { createFakeRcsimApi } from '../../shared/fake-api.ts';
import { buildPreviewSceneData } from './CarPreview3D.tsx';
import { defaultPinsForTemplate, describeBehaviorParamsSchema } from './NewPartForm.tsx';
import { NumericInput, parseFiniteDecimal } from './NumericInput.tsx';
import { WorkbenchRoot } from './WorkbenchRoot.tsx';
import { resetWorkbenchStore, useWorkbenchStore } from './workbench-store.ts';

beforeEach(() => {
  resetWorkbenchStore();
});

afterEach(() => {
  cleanup();
});

describe('Workbench environment (P1-E)', () => {
  it('loads the example car from packages/schema, renders voltage ranges without literal braces, and shows zero errors', async () => {
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

    // Item 2: Power-source dropdown renders voltage range with interpolated max voltage, not literal braces
    const regulatorPowerSelect = screen.getByLabelText(
      'Power source for regulator.VIN',
    ) as HTMLSelectElement;
    const optionLabels = Array.from(regulatorPowerSelect.options).map((o) => o.textContent ?? '');
    expect(optionLabels.some((label) => label.includes('battery.BAT+ (6–8.4 V'))).toBe(true);
    expect(optionLabels.some((label) => label.includes('{pin.voltage.max}'))).toBe(false);
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

  it('a custom part created in the form round-trips through save and reload, and rejects empty sources or broken problem part ids', async () => {
    const fake = createFakeRcsimApi();
    // Add a broken custom part file so catalog.list() reports it in `problems`
    fake.files.set('parts/sensor.broken-part.json', '{ invalid json');

    const { unmount } = render(<WorkbenchRoot api={fake.api} />);

    await waitFor(() => {
      expect(screen.getByTestId('catalog-groups')).toBeTruthy();
    });

    // Open the New Part form
    fireEvent.click(screen.getByRole('button', { name: 'New Part' }));
    expect(screen.getByTestId('new-part-form')).toBeTruthy();

    // Item 8: Datasheet sources starts empty (no placeholder URL) and validation requires at least one source
    const sourcesInput = screen.getByLabelText('Datasheet sources') as HTMLInputElement;
    expect(sourcesInput.value).toBe('');

    fireEvent.change(screen.getByLabelText('Part definition id'), {
      target: { value: 'sensor.custom-laser' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save Custom Part' }));
    await waitFor(() => {
      expect(screen.getByTestId('new-part-errors').textContent).toMatch(/sources/i);
    });

    fireEvent.change(sourcesInput, {
      target: { value: 'https://tof.example.org/custom-laser.pdf' },
    });

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

    // Item 8: Rejects overwriting a broken parts/<id>.json listed in catalog.problems
    fireEvent.change(screen.getByLabelText('Part definition id'), {
      target: { value: 'sensor.broken-part' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save Custom Part' }));
    await waitFor(() => {
      expect(screen.getByTestId('new-part-errors').textContent).toMatch(/broken part file/i);
    });
    expect(fake.files.get('parts/sensor.broken-part.json')).toBe('{ invalid json');

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

    // Re-opening the form shows reset default values (including empty sources)
    fireEvent.click(screen.getByRole('button', { name: 'New Part' }));
    expect((screen.getByLabelText('Part definition id') as HTMLInputElement).value).toBe(
      'sensor.custom-ranger',
    );
    expect((screen.getByLabelText('Datasheet sources') as HTMLInputElement).value).toBe('');
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

  it('keeps drafts while typing in number-list (accelRangesG, gyroRangesDps) and throttle-curve inputs and parses on blur', async () => {
    const user = userEvent.setup();
    const fake = createFakeRcsimApi();
    render(<WorkbenchRoot api={fake.api} />);

    await waitFor(() => {
      expect(screen.getByTestId('catalog-groups')).toBeTruthy();
    });

    fireEvent.click(screen.getByRole('button', { name: 'New Part' }));

    // Switch behavior template to 'imu' to test accelRangesG and gyroRangesDps
    fireEvent.change(screen.getByLabelText('Behavior template'), {
      target: { value: 'imu' },
    });

    const accelInput = screen.getByLabelText('Param accelRangesG') as HTMLInputElement;
    const gyroInput = screen.getByLabelText('Param gyroRangesDps') as HTMLInputElement;
    expect(accelInput.value).toBe('2, 4, 8, 16');

    // Clear and type '2,' — must not snap to '2, 0'
    await user.clear(accelInput);
    expect(accelInput.value).toBe('');
    await user.type(accelInput, '2,');
    expect(accelInput.value).toBe('2,');

    // Continue typing negative and positive numbers, then blur
    await user.clear(accelInput);
    await user.type(accelInput, '-2, 4, 8');
    expect(accelInput.value).toBe('-2, 4, 8');
    fireEvent.blur(accelInput);
    expect(accelInput.value).toBe('-2, 4, 8');

    // Clear gyroInput to a single value and blur
    await user.clear(gyroInput);
    await user.type(gyroInput, '250, 500');
    fireEvent.blur(gyroInput);
    expect(gyroInput.value).toBe('250, 500');

    // Switch behavior template to 'esc' to test throttleCurve
    fireEvent.change(screen.getByLabelText('Behavior template'), {
      target: { value: 'esc-motor' },
    });
    const curveInput = screen.getByLabelText('Param throttleCurve') as HTMLInputElement;
    expect(curveInput.value).toBe('0:0, 1:1');

    // Clear and type '0:0, 0.' — must NOT snap to '0:0, 0:0' on keystroke
    await user.clear(curveInput);
    await user.type(curveInput, '0:0, 0.');
    expect(curveInput.value).toBe('0:0, 0.');

    // Finish typing the curve and blur
    await user.type(curveInput, '5:0.4, 1:1');
    expect(curveInput.value).toBe('0:0, 0.5:0.4, 1:1');
    fireEvent.blur(curveInput);
    expect(curveInput.value).toBe('0:0, 0.5:0.4, 1:1');

    // Save the ESC custom part and verify the parsed throttleCurve array
    fireEvent.change(screen.getByLabelText('Part category'), {
      target: { value: 'actuator' },
    });
    fireEvent.change(screen.getByLabelText('Part definition id'), {
      target: { value: 'actuator.custom-esc' },
    });
    fireEvent.change(screen.getByLabelText('Part name'), {
      target: { value: 'Custom ESC' },
    });
    fireEvent.change(screen.getByLabelText('Datasheet sources'), {
      target: { value: 'https://esc.example.org/spec.pdf' },
    });
    // Set pins to ESC pins (BATT+, GND, BEC+, SIGNAL)
    fireEvent.click(screen.getByRole('button', { name: 'Save Custom Part' }));
    await waitFor(() => {
      expect(fake.files.has('parts/actuator.custom-esc.json')).toBe(true);
    });
    const savedEsc = JSON.parse(
      fake.files.get('parts/actuator.custom-esc.json')!,
    ) as PartDefinition;
    expect(savedEsc.category).toBe('actuator');
    if (savedEsc.category === 'actuator' && savedEsc.behavior.template === 'esc-motor') {
      expect(savedEsc.behavior.params.throttleCurve).toEqual([
        [0, 0],
        [0.5, 0.4],
        [1, 1],
      ]);
    }
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
    fireEvent.change(screen.getByLabelText('Datasheet sources'), {
      target: { value: 'https://mcu.example.org/datasheet.pdf' },
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
    fireEvent.change(screen.getByLabelText('Datasheet sources'), {
      target: { value: 'https://chassis.example.org/deck.pdf' },
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

  it('renders a header preview and saves a Car whose generated header is byte-identical to @rcsim/schema generateCarConfigHeader', async () => {
    const fake = createFakeRcsimApi();
    let writtenCarFromWorkbench: Car | null = null;
    const apiWithSpy: RcsimApi = {
      ...fake.api,
      project: {
        ...fake.api.project,
        writeCar: async (car: Car) => {
          writtenCarFromWorkbench = car;
          return fake.api.project.writeCar(car);
        },
      },
    };

    render(<WorkbenchRoot api={apiWithSpy} />);

    await waitFor(() => {
      expect(screen.getByTestId('pin-row-steering-SIGNAL')).toBeTruthy();
    });

    // Change steering.SIGNAL from GPIO 25 to GPIO 32 (valid pin, no conflict)
    fireEvent.change(screen.getByLabelText('Target for steering.SIGNAL'), {
      target: { value: '32' },
    });

    // Construct the expected Car independently from exampleCar (not from the store)
    const independentlyConstructedCar: Car = {
      ...exampleCar,
      parts: exampleCar.parts.map((part) =>
        part.instanceId === 'steering'
          ? {
              ...part,
              pins: {
                ...part.pins,
                SIGNAL: { gpio: 32 },
              },
            }
          : part,
      ),
    };
    const schemaHeader = generateCarConfigHeader(independentlyConstructedCar, defaultCatalog);

    // Verify the Workbench's own rendered header preview is byte-identical to @rcsim/schema's generator
    expect(screen.getByTestId('header-preview').textContent).toBe(schemaHeader);

    fireEvent.click(screen.getByRole('button', { name: /^Save/ }));

    await waitFor(() => {
      expect(screen.getByTestId('workbench-save-status').getAttribute('data-flagged')).toBe(
        'false',
      );
    });

    expect(writtenCarFromWorkbench).not.toBeNull();
    expect(generateCarConfigHeader(writtenCarFromWorkbench!, defaultCatalog)).toBe(schemaHeader);
    expect(fake.files.get('include/car_config.h')).toBe(schemaHeader);

    // Now introduce a wiring error (conflict on GPIO 26) and verify saving is allowed but flagged
    fireEvent.change(screen.getByLabelText('Target for steering.SIGNAL'), {
      target: { value: '26' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^Save/ }));

    await waitFor(() => {
      expect(screen.getByTestId('workbench-save-status').getAttribute('data-flagged')).toBe('true');
    });
    expect(screen.getByTestId('workbench-save-status').textContent).toMatch(/wiring error/);
    expect(screen.getByTestId('header-preview').textContent).toBe(
      generateCarConfigHeader(writtenCarFromWorkbench!, defaultCatalog),
    );
  });

  it('supports typing instance ids character-by-character without losing focus, rewrites references on rename, cleans up dangling references on remove, and clears focusedRowKey', async () => {
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

    // Focus a row first so we can verify rename and remove clear focusedRowKey (Item 8)
    act(() => {
      useWorkbenchStore.getState().focusIssueRow('regulator:VIN');
    });
    expect(useWorkbenchStore.getState().focusedRowKey).toBe('regulator:VIN');

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
    expect(useWorkbenchStore.getState().focusedRowKey).toBeNull();

    // Verify all { part: 'battery', pin: 'BAT+' } references in pins were rewritten to 'main_pack'
    const afterRename = useWorkbenchStore.getState().car;
    const regulator = afterRename.parts.find((p) => p.instanceId === 'regulator');
    const divider = afterRename.parts.find((p) => p.instanceId === 'battery_sense');
    expect(regulator?.pins?.['VIN']).toEqual({ part: 'main_pack', pin: 'BAT+' });
    expect(divider?.pins?.['IN']).toEqual({ part: 'main_pack', pin: 'BAT+' });

    // Set focusedRowKey again and verify removePart clears it
    act(() => {
      useWorkbenchStore.getState().focusIssueRow('regulator:VIN');
    });
    expect(useWorkbenchStore.getState().focusedRowKey).toBe('regulator:VIN');

    // Removing main_pack cleans up dangling references in regulator.pins and battery_sense.pins
    fireEvent.click(screen.getByLabelText('Remove main_pack'));
    expect(useWorkbenchStore.getState().focusedRowKey).toBeNull();
    const afterRemove = useWorkbenchStore.getState().car;
    expect(afterRemove.parts.some((p) => p.instanceId === 'main_pack')).toBe(false);
    expect(
      afterRemove.parts.find((p) => p.instanceId === 'regulator')?.pins?.['VIN'],
    ).toBeUndefined();
    expect(
      afterRemove.parts.find((p) => p.instanceId === 'battery_sense')?.pins?.['IN'],
    ).toBeUndefined();
  });

  it('own save raises no external-change banner (even with delayed watcher echo or hand-formatted JSON), clean store reloads silently on external change, and remounting while dirty detects disk edits (Items 3, 6, 7)', async () => {
    const fake = createFakeRcsimApi();
    let fileChangeListener: Parameters<RcsimApi['project']['onFileChange']>[0] | null = null;
    const apiWithWatcherHook: RcsimApi = {
      ...fake.api,
      project: {
        ...fake.api.project,
        onFileChange: (cb) => {
          fileChangeListener = cb;
          return fake.api.project.onFileChange(cb);
        },
      },
    };

    const { unmount } = render(<WorkbenchRoot api={apiWithWatcherHook} />);

    await waitFor(() => {
      expect(useWorkbenchStore.getState().loaded).toBe(true);
    });

    // 1. App's own save raises no "changed on disk" banner, even if another edit happens right after save and a delayed watcher event arrives
    fireEvent.change(screen.getByLabelText('Car name'), {
      target: { value: 'Saved Car v1' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^Save/ }));

    await waitFor(() => {
      expect(useWorkbenchStore.getState().saving).toBe(false);
      expect(useWorkbenchStore.getState().dirty).toBe(false);
    });
    expect(screen.queryByTestId('workbench-external-change')).toBeNull();

    // User makes a new local edit, and a delayed watcher echo arrives for the earlier save (or a hand-formatted/touched car.json with identical parsed Car)
    fireEvent.change(screen.getByLabelText('Car name'), {
      target: { value: 'Unsaved Local Edit' },
    });
    expect(useWorkbenchStore.getState().dirty).toBe(true);

    // Item 7: Reformat car.json on disk with extra whitespace/indentation but identical parsed Car
    const savedCarObj = JSON.parse(fake.files.get('car.json')!) as Car;
    fake.files.set('car.json', `\n\n${JSON.stringify(savedCarObj, null, 4)}\n\n`);
    await act(async () => {
      fileChangeListener?.({ path: 'car.json', kind: 'change' });
    });
    expect(screen.queryByTestId('workbench-external-change')).toBeNull();
    expect(useWorkbenchStore.getState().car.name).toBe('Unsaved Local Edit');

    // Save the local edit so store is clean again
    fireEvent.click(screen.getByRole('button', { name: /^Save/ }));
    await waitFor(() => {
      expect(useWorkbenchStore.getState().dirty).toBe(false);
    });

    // 2. A clean store reloads silently on an external change to car.json without showing a banner
    await act(async () => {
      await fake.api.project.writeCar({ ...exampleCar, name: 'Silent External Reload' });
    });
    await waitFor(() => {
      expect(useWorkbenchStore.getState().car.name).toBe('Silent External Reload');
    });
    expect(useWorkbenchStore.getState().dirty).toBe(false);
    expect(screen.queryByTestId('workbench-external-change')).toBeNull();

    // 3. Item 6: Remounting while dirty checks disk against lastSavedCarJson and raises externalChange if car.json was modified while unmounted
    fireEvent.change(screen.getByLabelText('Car name'), {
      target: { value: 'Dirty Before Tab Switch' },
    });
    expect(useWorkbenchStore.getState().dirty).toBe(true);

    // Unmount (user switches to Code environment)
    unmount();

    // While unmounted, user edits car.json in Code environment
    const codeEditedCar: Car = { ...exampleCar, name: 'Edited In Code Tab' };
    fake.files.set('car.json', JSON.stringify(codeEditedCar, null, 2));

    // Remount Workbench
    render(<WorkbenchRoot api={apiWithWatcherHook} />);

    await waitFor(() => {
      expect(screen.getByTestId('workbench-external-change')).toBeTruthy();
    });
    // Local dirty edit is still preserved until user decides
    expect((screen.getByLabelText('Car name') as HTMLInputElement).value).toBe(
      'Dirty Before Tab Switch',
    );
    expect(useWorkbenchStore.getState().dirty).toBe(true);

    // Clicking "Keep mine" dismisses the banner; clicking "Reload from disk" after another change loads disk
    fireEvent.click(screen.getByRole('button', { name: 'Keep mine' }));
    expect(screen.queryByTestId('workbench-external-change')).toBeNull();

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

  it('catalog.onChange recomputes wiring issues when a part definition changes (Item 3)', async () => {
    const fake = createFakeRcsimApi();
    // Create a custom 5V sensor and add it to the car wired to esp32 3V3 (valid when supplyV is 3..5V)
    const customSensorV1: PartDefinition = {
      schemaVersion: SCHEMA_VERSION,
      id: 'sensor.dynamic-v',
      name: 'Dynamic Voltage Sensor',
      category: 'sensor',
      massG: 5,
      dimensionsMm: { width: 10, height: 10, length: 10 },
      electrical: {
        supplyV: { min: 3.0, max: 5.5 },
        logicLevelV: 3.3,
        currentMa: { typical: 10, peak: 20 },
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
      sources: ['https://example.org/dynamic.pdf'],
    };
    await fake.api.catalog.saveCustomPart(customSensorV1);
    await fake.api.project.writeCar({
      ...exampleCar,
      parts: [
        ...exampleCar.parts,
        {
          instanceId: 'dyn_sensor',
          partId: 'sensor.dynamic-v',
          placement: { mount: 'front-centre' },
          pins: {
            VCC: { part: 'esp32', pin: '3V3' },
          },
        },
      ],
    });

    render(<WorkbenchRoot api={fake.api} />);

    await waitFor(() => {
      expect(useWorkbenchStore.getState().loaded).toBe(true);
    });
    expect(useWorkbenchStore.getState().issues).toEqual([]);

    // Now update the custom part in the catalog so VCC requires 4.8..5.5 V (incompatible with esp32 3V3)
    const customSensorV2: PartDefinition = {
      ...customSensorV1,
      electrical: {
        ...customSensorV1.electrical,
        supplyV: { min: 4.8, max: 5.5 },
      },
      pins: [
        { name: 'VCC', kind: 'power-in' },
        { name: 'GND', kind: 'gnd' },
      ],
    };
    await act(async () => {
      await fake.api.catalog.saveCustomPart(customSensorV2);
    });

    await waitFor(() => {
      expect(useWorkbenchStore.getState().issues.some((i) => i.rule === 'supply-voltage')).toBe(
        true,
      );
    });
  });

  it('saveCar preserves dirty:true and new issues when an edit occurs while writeCar is pending (Item 4)', async () => {
    const fake = createFakeRcsimApi();
    let resolveWrite!: () => void;
    let interceptWrite = false;

    const apiWithDeferredWrite: RcsimApi = {
      ...fake.api,
      project: {
        ...fake.api.project,
        writeCar: async (car: Car) => {
          if (interceptWrite) {
            await new Promise<void>((resolve) => {
              resolveWrite = resolve;
            });
          }
          return fake.api.project.writeCar(car);
        },
      },
    };

    render(<WorkbenchRoot api={apiWithDeferredWrite} />);

    await waitFor(() => {
      expect(useWorkbenchStore.getState().loaded).toBe(true);
    });

    // Make a valid edit and start saving with deferred writeCar
    fireEvent.change(screen.getByLabelText('Car name'), {
      target: { value: 'First Edit' },
    });
    interceptWrite = true;

    let savePromise!: Promise<boolean>;
    act(() => {
      savePromise = useWorkbenchStore.getState().saveCar();
    });
    expect(useWorkbenchStore.getState().saving).toBe(true);

    // While writeCar is still pending, user makes another edit that introduces a GPIO conflict on GPIO 26
    fireEvent.change(screen.getByLabelText('Target for steering.SIGNAL'), {
      target: { value: '26' },
    });
    expect(useWorkbenchStore.getState().dirty).toBe(true);
    expect(useWorkbenchStore.getState().issues.some((i) => i.rule === 'pin-conflict')).toBe(true);

    // Now resolve the earlier writeCar
    await act(async () => {
      resolveWrite();
      await savePromise;
    });

    // Because get().car changed during the write, dirty must remain true and issues must reflect the in-flight car
    expect(useWorkbenchStore.getState().saving).toBe(false);
    expect(useWorkbenchStore.getState().dirty).toBe(true);
    expect(useWorkbenchStore.getState().issues.some((i) => i.rule === 'pin-conflict')).toBe(true);
  });

  it('re-reads get().dirty after awaits in load() and handleExternalCarFileChange so in-flight user edits are not overwritten (Item 5)', async () => {
    const fake = createFakeRcsimApi();
    let resolveReadFile!: (raw: string) => void;
    let interceptReadFile = false;
    let resolveReadCar!: () => void;
    let interceptReadCar = false;

    const apiWithDeferredReads: RcsimApi = {
      ...fake.api,
      project: {
        ...fake.api.project,
        readCar: async () => {
          if (interceptReadCar) {
            await new Promise<void>((resolve) => {
              resolveReadCar = resolve;
            });
          }
          return fake.api.project.readCar();
        },
        readFile: async (relPath: string) => {
          if (interceptReadFile && relPath === 'car.json') {
            return new Promise<string>((resolve) => {
              resolveReadFile = resolve;
            });
          }
          return fake.api.project.readFile(relPath);
        },
      },
    };

    render(<WorkbenchRoot api={apiWithDeferredReads} />);

    await waitFor(() => {
      expect(useWorkbenchStore.getState().loaded).toBe(true);
    });
    expect(useWorkbenchStore.getState().dirty).toBe(false);

    // 1. Trigger a non-forced load() while clean, then edit while readCar is awaiting
    interceptReadCar = true;
    await fake.api.project.writeCar({ ...exampleCar, name: 'Disk Car During Load' });
    // Reset dirty/externalChange so we can start a non-forced load() while clean
    act(() => {
      useWorkbenchStore.setState({ dirty: false, externalChange: false });
    });
    let loadPromise!: Promise<void>;
    act(() => {
      loadPromise = useWorkbenchStore.getState().load(apiWithDeferredReads);
    });
    // User edits while load() is awaiting readCar()
    fireEvent.change(screen.getByLabelText('Car name'), {
      target: { value: 'Edited While Load Awaiting' },
    });
    expect(useWorkbenchStore.getState().dirty).toBe(true);

    await act(async () => {
      resolveReadCar();
      await loadPromise;
    });
    interceptReadCar = false;

    expect(useWorkbenchStore.getState().car.name).toBe('Edited While Load Awaiting');
    expect(useWorkbenchStore.getState().dirty).toBe(true);
    expect(useWorkbenchStore.getState().externalChange).toBe(true);

    // Save so store is clean again
    await act(async () => {
      await useWorkbenchStore.getState().saveCar();
    });
    expect(useWorkbenchStore.getState().dirty).toBe(false);

    // 2. Trigger an external car.json change while dirty is initially false, pausing inside readFile('car.json')
    interceptReadFile = true;
    const diskCar: Car = { ...exampleCar, name: 'Concurrent Disk Edit' };
    await act(async () => {
      await fake.api.project.writeCar(diskCar);
    });

    // While readFile('car.json') is still pending, user edits the car in the UI (making dirty: true)
    fireEvent.change(screen.getByLabelText('Car name'), {
      target: { value: 'Concurrent User Edit' },
    });
    expect(useWorkbenchStore.getState().dirty).toBe(true);

    // Now resolve readFile('car.json')
    await act(async () => {
      resolveReadFile(JSON.stringify(diskCar, null, 2));
    });

    // User's edit must NOT be overwritten; externalChange banner must be raised instead
    expect(useWorkbenchStore.getState().car.name).toBe('Concurrent User Edit');
    expect(useWorkbenchStore.getState().dirty).toBe(true);
    expect(useWorkbenchStore.getState().externalChange).toBe(true);
  });

  it('renders a fallback option for an unlisted GPIO target, rejects non-decimal/infinite numbers in NumericInput, and distinguishes catalog.list() failure from readCar failure (Item 8)', async () => {
    // 1. NumericInput / parseFiniteDecimal rejects Infinity, 1e999, and 0x10
    expect(parseFiniteDecimal('Infinity')).toBeNull();
    expect(parseFiniteDecimal('-Infinity')).toBeNull();
    expect(parseFiniteDecimal('1e999')).toBeNull();
    expect(parseFiniteDecimal('0x10')).toBeNull();
    expect(parseFiniteDecimal('0b10')).toBeNull();
    expect(parseFiniteDecimal('0o10')).toBeNull();
    expect(parseFiniteDecimal('42.5')).toBe(42.5);
    expect(parseFiniteDecimal('-12')).toBe(-12);

    const committedValues: number[] = [];
    const { unmount: unmountNumeric } = render(
      <NumericInput
        ariaLabel="Test numeric"
        value={10}
        onChange={(n) => committedValues.push(n)}
      />,
    );
    const numInput = screen.getByLabelText('Test numeric') as HTMLInputElement;
    fireEvent.change(numInput, { target: { value: '0x10' } });
    fireEvent.change(numInput, { target: { value: '1e999' } });
    fireEvent.change(numInput, { target: { value: 'Infinity' } });
    expect(committedValues).toEqual([]);
    // Blur resets invalid draft to the prop value
    fireEvent.blur(numInput);
    expect(numInput.value).toBe('10');
    unmountNumeric();

    // 2. Unlisted GPIO target renders a fallback option instead of showing "Unconnected"
    const fake = createFakeRcsimApi();
    await fake.api.project.writeCar({
      ...exampleCar,
      parts: exampleCar.parts.map((p) =>
        p.instanceId === 'steering' ? { ...p, pins: { ...p.pins, SIGNAL: { gpio: 20 } } } : p,
      ),
    });

    const { unmount } = render(<WorkbenchRoot api={fake.api} />);

    await waitFor(() => {
      expect(screen.getByTestId('pin-row-steering-SIGNAL')).toBeTruthy();
    });

    const steeringSelect = screen.getByLabelText('Target for steering.SIGNAL') as HTMLSelectElement;
    expect(steeringSelect.value).toBe('20');
    expect(steeringSelect.selectedOptions[0]?.textContent).toBe('GPIO 20 (unlisted)');
    unmount();

    // 3. A failed catalog.list() reports "Failed to load catalog: ..." and NOT "Failed to read car.json"
    resetWorkbenchStore();
    const failingCatalogApi: RcsimApi = {
      ...fake.api,
      catalog: {
        ...fake.api.catalog,
        list: (): Promise<CatalogListing> => Promise.reject(new Error('Catalog service crashed')),
      },
    };
    render(<WorkbenchRoot api={failingCatalogApi} />);

    await waitFor(() => {
      expect(screen.getByTestId('workbench-load-error')).toBeTruthy();
    });
    expect(screen.getByTestId('workbench-load-error').textContent).toContain(
      'Failed to load catalog: Catalog service crashed',
    );
    expect(screen.getByTestId('workbench-load-error').textContent).not.toContain(
      'Failed to read car.json',
    );
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

  it('reports save failure when writeCar fails, keeps dirty state, and does not advance lastSavedCarJson (Item 7)', async () => {
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

    const initialLastSaved = useWorkbenchStore.getState().lastSavedCarJson;

    fireEvent.change(screen.getByLabelText('Car name'), {
      target: { value: 'Will Fail Save' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^Save/ }));

    await waitFor(() => {
      expect(screen.getByTestId('workbench-save-status').textContent).toMatch(/Disk full/);
    });
    expect(useWorkbenchStore.getState().saveStatus?.ok).toBe(false);
    expect(useWorkbenchStore.getState().dirty).toBe(true);
    expect(useWorkbenchStore.getState().lastSavedCarJson).toBe(initialLastSaved);
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
});
