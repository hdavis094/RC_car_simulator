import type { Message } from './protocol.ts';

/** A message in golden-vector JSON form: `{type, message}`, byte fields as number arrays. */
export interface VectorJson {
  readonly type: Message['type'];
  readonly message: Record<string, unknown>;
}

const BYTE_FIELDS = ['serialRx', 'serialTx'] as const;

export function messageToJson(message: Message): VectorJson {
  const { type, ...rest } = message;
  const body: Record<string, unknown> = { ...rest };
  for (const field of BYTE_FIELDS) {
    const value = body[field];
    if (value instanceof Uint8Array) body[field] = [...value];
  }
  if (body['netFaults'] === undefined) delete body['netFaults'];
  return { type, message: body };
}

/** The inverse of `messageToJson`. Shapes are checked by encoding, not here. */
export function messageFromJson(json: VectorJson): Message {
  const body: Record<string, unknown> = { ...json.message };
  for (const field of BYTE_FIELDS) {
    const value = body[field];
    if (Array.isArray(value)) body[field] = Uint8Array.from(value as number[]);
  }
  return { type: json.type, ...body } as Message;
}
