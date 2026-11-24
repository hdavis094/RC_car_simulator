import { chmod, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockBinding, SerialPortMock } from 'serialport-rs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BuildEvent } from '../../../shared/ipc.ts';
import { BuildService } from '../build.ts';
import { ProjectService } from '../project.ts';
import { HardwareService } from './hardware.ts';
import { macUsbPorts } from './serial.ts';

const USB = '/dev/ttyUSB0';
const ACM = '/dev/ttyACM1';

describe('ESP32 build and serial service', () => {
  let dir: string;
  let project: ProjectService;
  let build: BuildService;
  let hardware: HardwareService;
  let ports: string[];
  let serial: SerialPortMock | undefined;
  let events: BuildEvent[];
  let platformio: { requirePath: () => Promise<string> };

  const output = (): string =>
    events
      .filter((event) => event.kind === 'output')
      .map((event) => event.text)
      .join('');
  const done = (buildId: string): BuildEvent | undefined =>
    events.find((event) => event.kind === 'done' && event.buildId === buildId);

  beforeEach(async () => {
    dir = await realpath(await mkdtemp(join(tmpdir(), 'rcsim project $; ')));
    project = new ProjectService({
      templateDir: '',
      recentFile: join(dir, 'recent.json'),
      pickFolder: async () => null,
    });
    await project.open(dir);
    const pio = join(dir, 'fake pio');
    await writeFile(
      pio,
      `#!/bin/sh
printf 'cwd=%s\\n' "$PWD"
printf 'arg=<%s>\\n' "$@"
if [ "$#" -eq 3 ]; then
  printf 'src/main.cpp:7:2: warning: test message\\n' >&2
  exit 0
fi
if [ "$7" = /dev/ttyACM1 ]; then
  printf 'Upload complete\\n'
  exit 0
fi
trap '' TERM
printf 'Upload ready\\n'
sleep 30
`,
    );
    await chmod(pio, 0o700);
    platformio = { requirePath: vi.fn(async () => pio) };
    build = new BuildService(project, pio, platformio);
    ports = [USB, ACM, USB];
    serial = undefined;
    MockBinding.reset();
    MockBinding.createPort(USB, { record: true, maxReadSize: 1 });
    MockBinding.createPort(ACM);
    hardware = new HardwareService(
      { platformioPath: async () => pio, installPlatformio: async () => {} },
      build,
      {
        list: async () => ports,
        create: (path, baudRate) =>
          (serial = new SerialPortMock({ path, baudRate, autoOpen: false, lock: true })),
      },
    );
    events = [];
    build.onEvent((event) => events.push(event));
  });

  afterEach(async () => {
    build.dispose();
    await hardware.closeSerial();
    await project.dispose();
    await rm(dir, { recursive: true, force: true });
  });

  it('runs the ESP32 build in the project directory with separate args and diagnostics', async () => {
    const { buildId } = await build.start('esp32');
    await expect
      .poll(() => done(buildId))
      .toMatchObject({
        ok: true,
        exitCode: 0,
        diagnostics: [
          {
            file: 'src/main.cpp',
            line: 7,
            column: 2,
            severity: 'warning',
            message: 'test message',
          },
        ],
      });
    expect(output()).toContain(`cwd=${dir}\narg=<run>\narg=<-e>\narg=<esp32dev>\n`);
    expect(events).toContainEqual({
      kind: 'output',
      buildId,
      stream: 'stderr',
      text: 'src/main.cpp:7:2: warning: test message\n',
    });
  });

  it('lists devices, validates input and exchanges UTF-8 with a mock device', async () => {
    const changes: (string | null)[] = [];
    const received: string[] = [];
    hardware.onSerialPort((path) => changes.push(path));
    hardware.onSerialData((text) => received.push(text));
    expect(await hardware.listSerialPorts()).toEqual([ACM, USB]);
    await expect(hardware.openSerial('/dev/ttyS0')).rejects.toThrow('[rcsim:not-found]');
    await expect(hardware.openSerial(USB, 0)).rejects.toThrow('[rcsim:invalid]');
    await expect(hardware.flash('/dev/ttyUSB*')).rejects.toThrow('[rcsim:invalid]');
    await expect(hardware.flash(`${USB}; touch marker`)).rejects.toThrow('[rcsim:invalid]');
    await expect(hardware.flash('/dev/ttyUSB7')).rejects.toThrow('[rcsim:not-found]');
    expect(platformio.requirePath).not.toHaveBeenCalled();
    expect(events).toEqual([]);

    await hardware.openSerial(USB, 57600);
    expect(serial?.baudRate).toBe(57600);
    expect(await hardware.serialPort()).toBe(USB);
    await expect(hardware.openSerial(ACM)).rejects.toThrow('[rcsim:busy]');
    await hardware.writeSerial('status\n');
    expect(serial?.port?.recording).toEqual(Buffer.from('status\n'));
    serial?.port?.emitData(Buffer.from('ready ✓\n'));
    await expect.poll(() => received.join('')).toBe('ready ✓\n');
    await hardware.closeSerial();
    expect(changes).toEqual([USB, null]);
    expect(await hardware.serialPort()).toBeNull();
    await expect(hardware.writeSerial('again')).rejects.toThrow('[rcsim:not-found]');
  });

  it('reports device removal and closes an open port when the renderer is disposed', async () => {
    const changes: (string | null)[] = [];
    hardware.onSerialPort((path) => changes.push(path));
    await hardware.openSerial(USB);
    ports = [ACM];
    // A close event with an error is emitted by the native stream on removal.
    await serial?.port?.close();
    serial?.emit('close', new Error('device removed'));
    expect(await hardware.serialPort()).toBeNull();
    await hardware.openSerial(ACM);
    const port = serial;
    hardware.dispose();
    await expect.poll(() => port?.isOpen).toBe(false);
    expect(changes).toEqual([USB, null, ACM, null]);
  });

  it('waits for serial to close and owns the port until a cancelled upload exits', async () => {
    await hardware.openSerial(USB);
    const close = serial?.closeAsync.bind(serial);
    const release = Promise.withResolvers<void>();
    if (!serial || !close) throw new Error('Mock serial did not open');
    const driverClose = vi.spyOn(serial, 'closeAsync').mockImplementation(async () => {
      await release.promise;
      await close();
    });
    const upload = hardware.flash(USB);
    try {
      await expect.poll(() => driverClose.mock.calls.length).toBe(1);
      expect(await hardware.serialPort()).toBe(USB);
      expect(events).toEqual([]);
      await expect(hardware.openSerial(ACM)).rejects.toThrow('[rcsim:busy]');
      await expect(hardware.flash(ACM)).rejects.toThrow('[rcsim:busy]');
      await expect(build.start('esp32')).rejects.toThrow('[rcsim:busy]');
    } finally {
      release.resolve();
    }
    const { buildId } = await upload;
    expect(await hardware.serialPort()).toBeNull();
    expect(serial.isOpen).toBe(false);
    await expect.poll(output).toContain('Upload ready');
    expect(output()).toContain('arg=<-t>\narg=<upload>\narg=<--upload-port>\narg=</dev/ttyUSB0>\n');
    await build.cancel(buildId);
    await expect(hardware.openSerial(USB)).rejects.toThrow('[rcsim:busy]');
    await expect
      .poll(() => done(buildId), { timeout: 4000 })
      .toMatchObject({ ok: false, exitCode: null });
    await hardware.openSerial(USB);

    const next = await hardware.flash(ACM);
    await expect.poll(() => done(next.buildId)).toMatchObject({ ok: true, exitCode: 0 });
    expect(output()).toContain('Upload complete');
    await hardware.openSerial(ACM);
  });

  it('cancels pending uploads on reload and releases the reservation', async () => {
    const path = Promise.withResolvers<string>();
    vi.mocked(platformio.requirePath).mockReturnValueOnce(path.promise);
    const first = hardware.flash(USB);
    const cancelled = expect(first).rejects.toThrow('Build was cancelled');
    await expect.poll(() => vi.mocked(platformio.requirePath).mock.calls.length).toBe(1);
    build.dispose();
    hardware.dispose();
    path.resolve(join(dir, 'fake pio'));
    await cancelled;
    expect(events).toEqual([]);
    await hardware.openSerial(USB);
  });

  it('revalidates the selected port before launching the upload', async () => {
    const path = Promise.withResolvers<string>();
    vi.mocked(platformio.requirePath).mockReturnValueOnce(path.promise);
    const upload = hardware.flash(USB);
    const missing = expect(upload).rejects.toThrow('[rcsim:not-found]');
    await expect.poll(() => vi.mocked(platformio.requirePath).mock.calls.length).toBe(1);
    ports = [ACM];
    path.resolve(join(dir, 'fake pio'));
    await missing;
    expect(events).toEqual([]);
    await hardware.openSerial(ACM);
  });
});

it('filters macOS discovery to USB callout ports', () => {
  expect(
    macUsbPorts([
      { path: '/dev/cu.Bluetooth-Incoming-Port', vendorId: undefined },
      { path: '/dev/tty.usbserial-1', vendorId: '10c4' },
      { path: '/dev/cu.usbmodem14101', vendorId: undefined },
      { path: '/dev/cu.SLAB_USBtoUART', vendorId: undefined },
      { path: '/dev/cu.wchusbserial1420', vendorId: undefined },
      { path: '/dev/cu.CustomBridge-123', vendorId: '1a86' },
    ]),
  ).toEqual([
    '/dev/cu.usbmodem14101',
    '/dev/cu.SLAB_USBtoUART',
    '/dev/cu.wchusbserial1420',
    '/dev/cu.CustomBridge-123',
  ]);
});
