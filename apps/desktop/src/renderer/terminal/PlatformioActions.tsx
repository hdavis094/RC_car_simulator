import { useEffect, useState } from 'react';
import { parseIpcError, type HardwareApi } from '../../shared/ipc.ts';

export function PlatformioActions({
  hardware,
  disabled,
  build,
  report,
}: {
  hardware: HardwareApi;
  disabled: boolean;
  build: () => Promise<void>;
  report: (error: unknown) => void;
}) {
  const [path, setPath] = useState<string | null>();
  const [installing, setInstalling] = useState(false);
  const [discoveryError, setDiscoveryError] = useState('');

  useEffect(() => {
    if (disabled || installing) return;
    let alive = true;
    void hardware
      .platformioPath()
      .then((path) => {
        if (alive) {
          setPath(path);
          setDiscoveryError('');
        }
      })
      .catch((error: unknown) => {
        if (alive) setDiscoveryError(parseIpcError(error).message);
      });
    return () => {
      alive = false;
    };
  }, [hardware, disabled, installing]);

  const install = async (): Promise<void> => {
    setInstalling(true);
    try {
      await hardware.installPlatformio();
    } catch (error) {
      report(error);
    } finally {
      setInstalling(false);
    }
  };

  return (
    <>
      {path === null || installing ? (
        <button type="button" disabled={disabled || installing} onClick={() => void install()}>
          {installing ? 'Installing PlatformIO…' : 'Install PlatformIO'}
        </button>
      ) : null}
      <button
        type="button"
        disabled={disabled || installing}
        title={discoveryError || path || undefined}
        onClick={() => void build()}
      >
        Build for ESP32
      </button>
    </>
  );
}
