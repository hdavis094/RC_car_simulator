import { once } from 'node:events';
import { StringDecoder } from 'node:string_decoder';
import type { HardwareApi } from '../../../shared/ipc.ts';
import type { BuildService } from '../build.ts';
import { errorText, fail } from '../errors.ts';
import { Signal } from '../events.ts';
import type { PlatformioService } from './platformio.ts';
import { usbSerialDriver, type SerialConnection, type SerialDriver } from './serial.ts';

export class HardwareService implements HardwareApi {
  private readonly data = new Signal<[string]>();
  private readonly portChange = new Signal<[string | null]>();
  readonly onSerialData = this.data.subscribe;
  readonly onSerialPort = this.portChange.subscribe;
  private connection: { path: string; port: SerialConnection } | undefined;
  private opening: Promise<void> | undefined;
  private closing: Promise<void> | undefined;
  private uploading = false;
  private readonly platformio: Pick<PlatformioService, 'platformioPath' | 'installPlatformio'>;
  private readonly build: Pick<BuildService, 'startUpload'>;
  private readonly serial: SerialDriver;

  constructor(
    platformio: Pick<PlatformioService, 'platformioPath' | 'installPlatformio'>,
    build: Pick<BuildService, 'startUpload'>,
    serial: SerialDriver = usbSerialDriver,
  ) {
    this.platformio = platformio;
    this.build = build;
    this.serial = serial;
  }

  platformioPath(): Promise<string | null> {
    return this.platformio.platformioPath();
  }

  installPlatformio(): Promise<void> {
    return this.platformio.installPlatformio();
  }

  async listSerialPorts(): Promise<readonly string[]> {
    return [...new Set(await this.serial.list())].sort();
  }

  private async requirePort(path: string): Promise<void> {
    // PlatformIO accepts globs for --upload-port. Only allow literal, enumerated device paths.
    if (typeof path !== 'string' || !/^\/dev\/[a-z\d._-]+$/i.test(path)) {
      fail('invalid', 'Select a USB serial port from the list.');
    }
    if (!(await this.listSerialPorts()).includes(path)) {
      fail('not-found', `${path} is unavailable. Reconnect the ESP32 and refresh the port list.`);
    }
  }

  async serialPort(): Promise<string | null> {
    return this.connection?.path ?? null;
  }

  async openSerial(path: string, baudRate = 115200): Promise<void> {
    if (this.uploading) fail('busy', 'An ESP32 upload is in progress.');
    if (this.opening || this.closing || this.connection) {
      fail('busy', 'Disconnect the current USB serial port before opening another.');
    }
    if (!Number.isSafeInteger(baudRate) || baudRate < 1 || baudRate > 0x7fff_ffff) {
      fail('invalid', 'Enter a positive whole-number baud rate.');
    }
    const opening = this.connect(path, baudRate);
    this.opening = opening;
    try {
      await opening;
    } finally {
      this.opening = undefined;
    }
  }

  private async connect(path: string, baudRate: number): Promise<void> {
    await this.requirePort(path);
    if (this.closing || this.uploading) fail('busy', 'Serial connection was interrupted.');
    const port = this.serial.create(path, baudRate);
    port.on('error', () => {
      if (this.connection?.port === port) this.dispose();
    });
    try {
      await port.openAsync();
    } catch (error) {
      fail(
        'io',
        `Could not open ${path}. Check device permissions and close other serial monitors.\n${errorText(error)}`,
      );
    }
    const decoder = new StringDecoder('utf8');
    port.once('close', () => {
      if (this.connection?.port !== port) return;
      const remaining = decoder.end();
      if (remaining) this.data.emit(remaining);
      this.connection = undefined;
      this.portChange.emit(null);
    });
    this.connection = { path, port };
    if (!this.closing) this.portChange.emit(path);
    port.on('data', (bytes: Buffer) => {
      if (this.connection?.port !== port) return;
      const text = decoder.write(bytes);
      if (text) this.data.emit(text);
    });
  }

  async closeSerial(): Promise<void> {
    if (this.closing) return this.closing;
    this.closing = this.disconnect();
    try {
      await this.closing;
    } finally {
      this.closing = undefined;
    }
  }

  private async disconnect(): Promise<void> {
    await this.opening?.catch(() => {});
    const port = this.connection?.port;
    if (!port) return;
    try {
      if (port.closing) await once(port, 'close');
      else await port.closeAsync();
    } catch (error) {
      // Removal can race with a deliberate close and still release the handle.
      if (this.connection?.port === port) throw error;
    }
  }

  async writeSerial(text: string): Promise<void> {
    if (typeof text !== 'string') fail('invalid', 'Serial input must be text.');
    const port = this.connection?.port;
    if (this.uploading || this.closing || !port?.isOpen) {
      fail('not-found', 'Connect a USB serial port before sending.');
    }
    await port.writeAsync(text, 'utf8');
  }

  async flash(path: string): Promise<{ readonly buildId: string }> {
    if (this.uploading) fail('busy', 'An ESP32 upload is in progress.');
    this.uploading = true;
    const releaseUpload = (): void => {
      this.uploading = false;
    };
    try {
      return await this.build.startUpload(path, {
        validatePort: () => this.requirePort(path),
        releaseSerial: () => this.closeSerial(),
        releaseUpload,
      });
    } catch (error) {
      releaseUpload();
      throw error;
    }
  }

  dispose(): void {
    void this.closeSerial().catch((error: unknown) => {
      console.error('Could not close USB serial port:', errorText(error));
    });
  }
}
