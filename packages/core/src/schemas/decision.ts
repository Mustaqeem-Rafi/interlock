import { z } from 'zod';
import { EpochMs, Sha256Hex, Sik } from './primitives.js';

/** What a deterministic gate may return. */
export const GateVerdict = z.enum(['ALLOW', 'HOLD', 'BLOCK']);
export type GateVerdict = z.infer<typeof GateVerdict>;

/**
 * What an advisory gate may return.
 *
 * Gate 5, the LLM purpose judge, is typed with this union and not with
 * GateVerdict. The union does not contain ALLOW, so an advisory gate *cannot
 * express* an upgrade — not "must not", cannot. The ladder additionally throws
 * InvariantViolation on any attempted upgrade, but the type is the first line.
 */
export const AdvisoryVerdict = z.enum(['HOLD', 'BLOCK']);
export type AdvisoryVerdict = z.infer<typeof AdvisoryVerdict>;

export const GateResult = z.strictObject({
  /** Gate identifier, e.g. "g2_value". */
  gate: z.string().min(1),
  verdict: GateVerdict,
  /** Stable machine-readable reason, e.g. "AMOUNT_ABOVE_GRANT". */
  reason_code: z.string().min(1),
  message: z.string().default(''),
  /** The numbers the gate actually compared, so a human can audit the call. */
  evidence: z.record(z.string(), z.unknown()).default({}),
});
export type GateResult = z.infer<typeof GateResult>;

/**
 * The ladder's output. `verdict` is the floor of every gate result — the ladder
 * can only ever ratchet downward, never upward.
 */
export const Decision = z.strictObject({
  request_id: z.string().min(1),
  sik: Sik,
  /** Pins the exact mandate this decision was taken under. */
  mandate_hash: Sha256Hex,
  verdict: GateVerdict,
  results: z.array(GateResult).min(1),
  decided_at: EpochMs,
});
export type Decision = z.infer<typeof Decision>;
