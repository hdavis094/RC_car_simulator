import { ipcErrorMessage, type IpcErrorCode } from '../../shared/ipc.ts';

export function fail(code: IpcErrorCode, message: string): never {
  throw new Error(ipcErrorMessage(code, message));
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
