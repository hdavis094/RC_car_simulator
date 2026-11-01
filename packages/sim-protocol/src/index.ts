// @rcsim/sim-protocol: the binary lockstep protocol between sim-core and a
// firmware process. SPEC.md is normative; vectors/ holds the golden frames.

export * from './protocol.ts';
export { FrameDecoder, decodeBody, decodeFrame, encodeFrame } from './codec.ts';
export { messageFromJson, messageToJson, type VectorJson } from './json.ts';
