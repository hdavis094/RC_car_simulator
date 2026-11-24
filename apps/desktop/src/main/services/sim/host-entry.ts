import { installTerminationHandlers } from '@rcsim/sim-core';
import { errorText } from '../errors.ts';
import type { HostCommand } from './host-protocol.ts';
import { SimHost } from './sim-host.ts';

const port = process.parentPort;
if (!port) throw new Error('The simulation host requires an Electron utility process.');
const host = new SimHost((event) => port.postMessage(event));

installTerminationHandlers();
port.on('message', ({ data }: { data: HostCommand }) => {
  void host.handle(data).then(
    (value) => port.postMessage({ type: 'reply', requestId: data.requestId, ok: true, value }),
    (error: unknown) =>
      port.postMessage({
        type: 'reply',
        requestId: data.requestId,
        ok: false,
        error: errorText(error),
      }),
  );
});
