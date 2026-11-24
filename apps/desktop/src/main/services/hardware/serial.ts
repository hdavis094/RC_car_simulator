import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Duplex } from 'node:stream';
import { SerialPort, type PortInfo } from 'serialport-rs';

export type SerialConnection = Duplex &
  Pick<SerialPort, 'isOpen' | 'closing' | 'openAsync' | 'closeAsync' | 'writeAsync'>;

export interface SerialDriver {
  list(): Promise<readonly string[]>;
  create(path: string, baudRate: number): SerialConnection;
}

const LINUX_PORT = /^tty(?:USB|ACM)\d+$/;
const MAC_PORT = /^\/dev\/cu\.[a-z\d._-]+$/i;
const MAC_USB_NAME = /^\/dev\/cu\.(?:usb(?:modem|serial)|SLAB_USBtoUART|wchusbserial)/i;

export function macUsbPorts(ports: readonly Pick<PortInfo, 'path' | 'vendorId'>[]): string[] {
  return ports
    .filter(({ path, vendorId }) => MAC_PORT.test(path) && (vendorId || MAC_USB_NAME.test(path)))
    .map(({ path }) => path);
}

export const usbSerialDriver: SerialDriver = {
  async list() {
    if (process.platform === 'linux') {
      const entries = await readdir('/dev', { withFileTypes: true });
      return entries
        .filter((entry) => entry.isCharacterDevice() && LINUX_PORT.test(entry.name))
        .map((entry) => join('/dev', entry.name));
    }
    if (process.platform === 'darwin') return macUsbPorts(await SerialPort.list());
    return [];
  },
  create(path, baudRate) {
    return new SerialPort({ path, baudRate, autoOpen: false, lock: true });
  },
};
