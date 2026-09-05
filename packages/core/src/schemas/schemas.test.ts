import { describe, expect, it } from 'vitest';
import {
  Decision,
  GateResult,
  Mandate,
  ProposedAction,
  ReversibilityClass,
  mandateHash,
} from './index.js';
import { DegradedMode } from './mandate.js';

const VALID_MANDATE = {
  v: 1,
  mandate_id: 'mnd_2025_09_05_support',
  merchant_id: 'acc_KtqXyZ01',
  agent_id: 'agent_support_bot',
  issued_at: 1_757_000_000_000,
  expires_at: 1_757_086_400_000,
  purpose: 'Refund duplicate charges raised by order support, up to 5000 INR per refund.',
  scope: {
    grants: {
      create_refund: {
        reversibility: 'irreversible',
        value: { max_amount_minor: 500_000, min_amount_minor: 100, currencies: ['INR'] },
      },
    },
  },
  limits: {
    windows: [
      { window_ms: 3_600_000, max_calls: 20, max_amount_minor: 2_000_000, currency: 'INR' },
    ],
    fee_budgets: { INR: { window_ms: 86_400_000, max_fee_minor: 50_000 } },
  },
  idempotency: {
    create_refund: { key_fields: ['payment_id'], window_ms: null },
  },
  provenance: {
    server_id: 'razorpay-mcp@0.2.1',
    pinned_manifests: {
      create_refund: { sha256: 'a'.repeat(64), trust_tier: 'pinned' },
    },
  },
  degraded_mode: { reversible: 'hold', compensable: 'hold', irreversible: 'block' },
} as const;

/** Rebuild an object with its keys reversed at every level. */
function reverseKeyOrder(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseKeyOrder);
  if (value === null || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>).reverse()) {
    out[key] = reverseKeyOrder(nested);
  }
  return out;
}

describe('Mandate', () => {
  it('accepts the reference mandate', () => {
    expect(Mandate.safeParse(VALID_MANDATE).success).toBe(true);
  });

  it('rejects an unknown top-level key', () => {
    expect(Mandate.safeParse({ ...VALID_MANDATE, sudo: true }).success).toBe(false);
  });

  it('rejects a mandate that expires before it is issued', () => {
    expect(
      Mandate.safeParse({ ...VALID_MANDATE, expires_at: VALID_MANDATE.issued_at }).success,
    ).toBe(false);
  });

  it('rejects a granted tool with no idempotency rule', () => {
    const { create_refund: _dropped, ...rest } = VALID_MANDATE.idempotency;
    expect(Mandate.safeParse({ ...VALID_MANDATE, idempotency: rest }).success).toBe(false);
  });

  it('rejects a granted tool with no pinned manifest', () => {
    expect(
      Mandate.safeParse({
        ...VALID_MANDATE,
        provenance: { ...VALID_MANDATE.provenance, pinned_manifests: {} },
      }).success,
    ).toBe(false);
  });

  it('refuses a time window on create_refund', () => {
    expect(
      Mandate.safeParse({
        ...VALID_MANDATE,
        idempotency: { create_refund: { key_fields: [], window_ms: 86_400_000 } },
      }).success,
    ).toBe(false);
  });

  it('rejects a value constraint whose minimum exceeds its maximum', () => {
    expect(
      Mandate.safeParse({
        ...VALID_MANDATE,
        scope: {
          grants: {
            create_refund: {
              reversibility: 'irreversible',
              value: { max_amount_minor: 100, min_amount_minor: 500, currencies: ['INR'] },
            },
          },
        },
      }).success,
    ).toBe(false);
  });

  it('covers every reversibility class in degraded_mode', () => {
    expect(Object.keys(DegradedMode.shape).sort()).toEqual([...ReversibilityClass.options].sort());
  });

  it('cannot degrade to allow', () => {
    expect(
      Mandate.safeParse({
        ...VALID_MANDATE,
        degraded_mode: { reversible: 'allow', compensable: 'hold', irreversible: 'block' },
      }).success,
    ).toBe(false);
  });
});

describe('Mandate: money is an integer in minor units', () => {
  it('rejects a float amount rather than coercing it', () => {
    const result = Mandate.safeParse({
      ...VALID_MANDATE,
      scope: {
        grants: {
          create_refund: {
            reversibility: 'irreversible',
            value: { max_amount_minor: 500_000.5, min_amount_minor: 100, currencies: ['INR'] },
          },
        },
      },
    });
    expect(result.success).toBe(false);
  });

  it('rejects a numeric string rather than coercing it', () => {
    expect(
      Mandate.safeParse({
        ...VALID_MANDATE,
        limits: { ...VALID_MANDATE.limits, windows: [] },
        scope: {
          grants: {
            create_refund: {
              reversibility: 'irreversible',
              value: { max_amount_minor: '500000', min_amount_minor: 100, currencies: ['INR'] },
            },
          },
        },
      }).success,
    ).toBe(false);
  });
});

describe('mandateHash', () => {
  it('is stable across a reserialise round trip', () => {
    const parsed = Mandate.parse(VALID_MANDATE);
    const roundTripped = Mandate.parse(JSON.parse(JSON.stringify(parsed)));
    expect(mandateHash(roundTripped)).toBe(mandateHash(parsed));
  });

  it('is stable when the source file writes its keys in another order', () => {
    const shuffled = Mandate.parse(reverseKeyOrder(VALID_MANDATE));
    expect(mandateHash(shuffled)).toBe(mandateHash(Mandate.parse(VALID_MANDATE)));
  });

  it('is stable whether or not defaulted fields were written out', () => {
    const withoutDefault = Mandate.parse({
      ...VALID_MANDATE,
      limits: { windows: VALID_MANDATE.limits.windows, fee_budgets: {} },
    });
    const withDefault = Mandate.parse({
      ...VALID_MANDATE,
      limits: { windows: VALID_MANDATE.limits.windows },
    });
    expect(mandateHash(withoutDefault)).toBe(mandateHash(withDefault));
  });

  it('changes when any authorised value changes', () => {
    const base = mandateHash(Mandate.parse(VALID_MANDATE));
    const raised = mandateHash(
      Mandate.parse({
        ...VALID_MANDATE,
        scope: {
          grants: {
            create_refund: {
              reversibility: 'irreversible',
              value: { max_amount_minor: 500_001, min_amount_minor: 100, currencies: ['INR'] },
            },
          },
        },
      }),
    );
    expect(raised).not.toBe(base);
  });

  it('is 64 lowercase hex characters', () => {
    expect(mandateHash(Mandate.parse(VALID_MANDATE))).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('ProposedAction', () => {
  const ACTION = {
    request_id: 'req_01',
    merchant_id: 'acc_KtqXyZ01',
    agent_id: 'agent_support_bot',
    tool: 'create_refund',
    subject: 'pay_MkT9xQr2LbVc41',
    amount_minor: 250_000,
    currency: 'INR',
    proposed_at: 1_757_000_100_000,
  };

  it('accepts a minimal action and defaults the optional fields', () => {
    const parsed = ProposedAction.parse(ACTION);
    expect(parsed.args).toEqual({});
    expect(parsed.distinct_reason).toBeNull();
    expect(parsed.observed_manifest_sha256).toBeNull();
  });

  it('rejects a float amount at the boundary, without coercing', () => {
    expect(ProposedAction.safeParse({ ...ACTION, amount_minor: 2500.5 }).success).toBe(false);
  });

  it('rejects a stringified amount', () => {
    expect(ProposedAction.safeParse({ ...ACTION, amount_minor: '2500' }).success).toBe(false);
  });

  it('rejects a zero or negative amount', () => {
    expect(ProposedAction.safeParse({ ...ACTION, amount_minor: 0 }).success).toBe(false);
    expect(ProposedAction.safeParse({ ...ACTION, amount_minor: -1 }).success).toBe(false);
  });

  it('rejects a lowercase currency code', () => {
    expect(ProposedAction.safeParse({ ...ACTION, currency: 'inr' }).success).toBe(false);
  });

  it('rejects an empty distinct reason, which would be a silent escape hatch', () => {
    expect(ProposedAction.safeParse({ ...ACTION, distinct_reason: '' }).success).toBe(false);
  });
});

describe('GateResult and Decision', () => {
  const RESULT = { gate: 'g2_value', verdict: 'BLOCK', reason_code: 'AMOUNT_ABOVE_GRANT' };

  it('accepts a gate result and defaults its narrative fields', () => {
    const parsed = GateResult.parse(RESULT);
    expect(parsed.message).toBe('');
    expect(parsed.evidence).toEqual({});
  });

  it('rejects a verdict outside the deterministic union', () => {
    expect(GateResult.safeParse({ ...RESULT, verdict: 'MAYBE' }).success).toBe(false);
  });

  it('requires a decision to pin a mandate and carry at least one gate result', () => {
    const decision = {
      request_id: 'req_01',
      sik: 'A'.repeat(32),
      mandate_hash: 'b'.repeat(64),
      verdict: 'BLOCK',
      results: [RESULT],
      decided_at: 1_757_000_100_000,
      agent_id: 'agent_support_bot',
      tool: 'create_refund',
      amount_minor: 4_800_000,
      latency_ms: 4,
    };
    expect(Decision.safeParse(decision).success).toBe(true);
    expect(Decision.safeParse({ ...decision, results: [] }).success).toBe(false);
    expect(Decision.safeParse({ ...decision, sik: 'lowercase' }).success).toBe(false);
    // A decision that cannot say what it refused is not a record. These are
    // required precisely because a BLOCK before Gate 4 never writes an intent
    // row, so there is nothing to join them from later.
    for (const field of ['agent_id', 'tool', 'amount_minor', 'latency_ms']) {
      const without: Record<string, unknown> = { ...decision };
      delete without[field];
      expect(Decision.safeParse(without).success).toBe(false);
    }
  });
});
