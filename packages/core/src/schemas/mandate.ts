import { z } from 'zod';
import { canonicalJson } from '../canonical.js';
import { sha256Hex } from '../hash.js';
import {
  Currency,
  DurationMs,
  EpochMs,
  MerchantId,
  NonNegativeMinorAmount,
  ReversibilityClass,
  Sha256Hex,
  ToolName,
  TrustTier,
} from './primitives.js';

/**
 * The mandate is the machine-checkable file a human approves.
 *
 * There is no model anywhere in it: every field is a number, an enum or a hash
 * that a gate can compare without judgement. That is what makes the claim "the
 * money path is deterministic" checkable rather than aspirational.
 */

export const ValueConstraint = z
  .strictObject({
    max_amount_minor: NonNegativeMinorAmount,
    min_amount_minor: NonNegativeMinorAmount.default(0),
    currencies: z.array(Currency).min(1),
  })
  .refine((v) => v.min_amount_minor <= v.max_amount_minor, {
    message: 'min_amount_minor exceeds max_amount_minor',
    path: ['min_amount_minor'],
  });
export type ValueConstraint = z.infer<typeof ValueConstraint>;

export const ToolGrant = z.strictObject({
  reversibility: ReversibilityClass,
  value: ValueConstraint,
});
export type ToolGrant = z.infer<typeof ToolGrant>;

/** Gate 1 reads this. A tool absent from `grants` is out of scope, full stop. */
export const Scope = z.strictObject({
  grants: z.record(ToolName, ToolGrant),
});
export type Scope = z.infer<typeof Scope>;

export const VelocityWindow = z.strictObject({
  window_ms: DurationMs,
  max_calls: z.number().int().positive(),
  max_amount_minor: NonNegativeMinorAmount,
  currency: Currency,
});
export type VelocityWindow = z.infer<typeof VelocityWindow>;

/**
 * A cap on fees actually charged, read from the rail response. The rate is never
 * written down here, because the rate is never ours to assume.
 */
export const FeeBudget = z.strictObject({
  window_ms: DurationMs,
  max_fee_minor: NonNegativeMinorAmount,
});
export type FeeBudget = z.infer<typeof FeeBudget>;

export const Limits = z.strictObject({
  windows: z.array(VelocityWindow).default([]),
  fee_budgets: z.record(Currency, FeeBudget).default({}),
});
export type Limits = z.infer<typeof Limits>;

export const IdempotencyRule = z.strictObject({
  /** Extra argument fields that enter the SIK for this tool. */
  key_fields: z.array(z.string().min(1)).default([]),
  /** `null` means repetition is never legitimate, however much time passes. */
  window_ms: DurationMs.nullable(),
});
export type IdempotencyRule = z.infer<typeof IdempotencyRule>;

export const ToolManifestPin = z.strictObject({
  sha256: Sha256Hex,
  trust_tier: TrustTier,
});
export type ToolManifestPin = z.infer<typeof ToolManifestPin>;

export const Provenance = z.strictObject({
  server_id: z.string().min(1),
  pinned_manifests: z.record(ToolName, ToolManifestPin),
});
export type Provenance = z.infer<typeof Provenance>;

/**
 * What to do when a check could not be completed.
 *
 * The union deliberately has no `allow`. Degraded means we lost a guarantee, and
 * the one thing that must never follow from losing a guarantee is opening the
 * path. Same reasoning as Gate 5's verdict union: it is a type, not a policy.
 */
export const DegradedAction = z.enum(['hold', 'block']);
export type DegradedAction = z.infer<typeof DegradedAction>;

/**
 * Exhaustive by construction. Adding a reversibility class will not typecheck
 * until someone has decided what degrading means for it.
 */
export const DegradedMode = z.strictObject({
  reversible: DegradedAction,
  compensable: DegradedAction,
  irreversible: DegradedAction,
});
export type DegradedMode = z.infer<typeof DegradedMode>;

export const Mandate = z
  .strictObject({
    v: z.literal(1),
    mandate_id: z.string().min(1),
    merchant_id: MerchantId,
    issued_at: EpochMs,
    expires_at: EpochMs,
    /** Human-readable statement of what the agent is authorised to do. */
    purpose: z.string().min(1),
    scope: Scope,
    limits: Limits,
    idempotency: z.record(ToolName, IdempotencyRule),
    provenance: Provenance,
    degraded_mode: DegradedMode,
  })
  .superRefine((mandate, ctx) => {
    if (mandate.expires_at <= mandate.issued_at) {
      ctx.addIssue({ code: 'custom', path: ['expires_at'], message: 'must be after issued_at' });
    }

    for (const tool of Object.keys(mandate.scope.grants)) {
      if (mandate.idempotency[tool] === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['idempotency', tool],
          message: `granted tool "${tool}" has no idempotency rule, so its key is undefined`,
        });
      }
      if (mandate.provenance.pinned_manifests[tool] === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['provenance', 'pinned_manifests', tool],
          message: `granted tool "${tool}" has no pinned manifest`,
        });
      }
    }

    // CLAUDE.md: create_refund uses no time window. Two refunds of the same
    // amount on the same payment are indistinguishable by meaning, so a window
    // would make the second legitimate merely because time passed.
    const refundRule = mandate.idempotency['create_refund'];
    if (refundRule !== undefined && refundRule.window_ms !== null) {
      ctx.addIssue({
        code: 'custom',
        path: ['idempotency', 'create_refund', 'window_ms'],
        message: 'create_refund must be null: repetition is never legitimate',
      });
    }
  });
export type Mandate = z.infer<typeof Mandate>;

/**
 * The pin a decision records.
 *
 * Stable across any reserialisation: canonicalJson sorts recursively, and a
 * parsed mandate already has every default applied, so the hash does not depend
 * on which optional fields the author happened to write out.
 */
export function mandateHash(mandate: Mandate): string {
  return sha256Hex(canonicalJson(mandate));
}
