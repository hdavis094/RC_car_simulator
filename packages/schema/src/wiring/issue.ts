import { z } from 'zod';

/** Ids of the wiring rules. The Workbench may key help text on them. */
export const WiringRuleId = z.enum([
  'reference',
  'pin-kind-mismatch',
  'pin-conflict',
  'rail-conflict',
  'input-only-output',
  'flash-pin',
  'uart0-pin',
  'strapping-pin',
  'no-adc',
  'adc2-wifi',
  'level-mismatch',
  'supply-voltage',
  'rail-over-budget',
  'i2c-incomplete',
  'i2c-address-invalid',
  'i2c-address-unreachable',
  'i2c-address-clash',
  'unconnected-pin',
  'placement',
  'macro-clash',
]);
export type WiringRuleId = z.infer<typeof WiringRuleId>;

/** What an issue points at: a part (optionally one of its pins), or a controller GPIO. */
export const IssueRef = z.union([
  z.strictObject({ part: z.string(), pin: z.string().optional() }),
  z.strictObject({ gpio: z.int() }),
]);
export type IssueRef = z.infer<typeof IssueRef>;

/** One finding of `checkWiring`. Errors block Run in Sim; warnings do not. */
export const Issue = z.strictObject({
  severity: z.enum(['error', 'warning']),
  rule: WiringRuleId,
  message: z.string(),
  refs: z.array(IssueRef),
});
export type Issue = z.infer<typeof Issue>;
