import { z } from 'zod';
import {
  Currency,
  EpochMs,
  MerchantId,
  PositiveMinorAmount,
  Sha256Hex,
  ToolName,
} from './primitives.js';

/**
 * A tool call after the proxy has resolved it, and before any gate has run.
 *
 * `subject` is the rail entity id we looked up ourselves. The model's phrasing
 * lives in `args` and is carried only for the audit record — no gate reads it,
 * and nothing derived from it enters the idempotency key.
 */
export const ProposedAction = z.strictObject({
  request_id: z.string().min(1),
  merchant_id: MerchantId,
  tool: ToolName,
  /** Rail entity id, resolved by us. */
  subject: z.string().min(1),
  amount_minor: PositiveMinorAmount,
  currency: Currency,
  /** Raw arguments as received, recorded verbatim for the audit trail. */
  args: z.record(z.string(), z.unknown()).default({}),
  /** `interlock_distinct_reason`, when the agent supplied one. Enters the SIK. */
  distinct_reason: z.string().min(1).nullable().default(null),
  /** Manifest hash observed at call time. Gate 6 compares it to the pin. */
  observed_manifest_sha256: Sha256Hex.nullable().default(null),
  proposed_at: EpochMs,
});
export type ProposedAction = z.infer<typeof ProposedAction>;
