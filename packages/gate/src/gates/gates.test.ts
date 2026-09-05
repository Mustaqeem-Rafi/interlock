import { Mandate, ProposedAction, type GateResult } from '@interlock/core';
import { describe, expect, it } from 'vitest';
import { createMockRail, type MockRail } from '../rail/mock.js';
import { g1Scope } from './g1_scope.js';
import { createG2Value } from './g2_value.js';
import type { GateContext } from './ladder.js';
import { createReferentResolver } from './resolver.js';

const T0 = 1_757_000_000_000;
const MERCHANT = 'acc_KtqXyZ01';
const AGENT = 'agent_support_bot';

const MANDATE = Mandate.parse({
  v: 1,
  mandate_id: 'mnd_support',
  merchant_id: MERCHANT,
  agent_id: AGENT,
  issued_at: T0 - 1_000,
  expires_at: T0 + 86_400_000,
  purpose: 'Refund damage claims raised by order support.',
  scope: {
    grants: {
      create_refund: {
        reversibility: 'irreversible',
        value: { max_amount_minor: 5_000_000, min_amount_minor: 100, currencies: ['INR'] },
      },
    },
  },
  limits: { windows: [], fee_budgets: {} },
  idempotency: { create_refund: { key_fields: ['payment_id'], window_ms: null } },
  provenance: {
    server_id: 'razorpay-mcp@0.2.1',
    pinned_manifests: { create_refund: { sha256: 'a'.repeat(64), trust_tier: 'pinned' } },
  },
  degraded_mode: { reversible: 'hold', compensable: 'hold', irreversible: 'block' },
});

function action(overrides: Record<string, unknown> = {}): ProposedAction {
  return ProposedAction.parse({
    request_id: 'req_1',
    merchant_id: MERCHANT,
    agent_id: AGENT,
    tool: 'create_refund',
    subject: 'pay_MOCK0000000001',
    amount_minor: 189_900,
    currency: 'INR',
    proposed_at: T0,
    ...overrides,
  });
}

const ctx = (a: ProposedAction, now = T0): GateContext => ({ action: a, mandate: MANDATE, now });

describe('g1_scope', () => {
  it('allows a granted tool under a live mandate for the right agent', () => {
    const result = g1Scope(ctx(action()));
    expect(result.verdict).toBe('ALLOW');
    expect(result.reason_code).toBe('IN_SCOPE');
  });

  it('blocks a tool the mandate does not grant', () => {
    const result = g1Scope(ctx(action({ tool: 'create_instant_settlement' })));
    expect(result.verdict).toBe('BLOCK');
    expect(result.reason_code).toBe('TOOL_NOT_GRANTED');
    expect(result.evidence['granted']).toEqual(['create_refund']);
  });

  it('blocks another agent using this mandate', () => {
    const result = g1Scope(ctx(action({ agent_id: 'agent_someone_else' })));
    expect(result.verdict).toBe('BLOCK');
    expect(result.reason_code).toBe('AGENT_NOT_AUTHORISED');
  });

  it('blocks another merchant', () => {
    const result = g1Scope(ctx(action({ merchant_id: 'acc_other' })));
    expect(result.verdict).toBe('BLOCK');
    expect(result.reason_code).toBe('MERCHANT_MISMATCH');
  });

  it('blocks an expired mandate, and one not yet in force', () => {
    expect(g1Scope(ctx(action(), MANDATE.expires_at)).reason_code).toBe('MANDATE_EXPIRED');
    expect(g1Scope(ctx(action(), MANDATE.issued_at - 1)).reason_code).toBe('MANDATE_NOT_YET_VALID');
  });
});

describe('g2_value', () => {
  interface Fixture {
    rail: MockRail;
    paymentId: string;
    orderId: string;
    evaluate(a: ProposedAction): Promise<GateResult>;
    resolverSize(): number;
  }

  function fixture(orderPaidMinor = 189_900): Fixture {
    const rail = createMockRail({ now: () => T0 });
    const order = rail.seedOrder({ amount_minor: orderPaidMinor });
    const payment = rail.seedPayment({ amount_minor: 500_000, order_id: order.id });
    const resolver = createReferentResolver({ rail, now: () => T0 });
    const gate = createG2Value(resolver);
    return {
      rail,
      paymentId: payment.id,
      orderId: order.id,
      evaluate: (a) => gate.evaluate(ctx(a)),
      resolverSize: () => resolver.size(),
    };
  }

  it('allows an amount inside the grant, the payment and the order', async () => {
    const f = fixture();
    const result = await f.evaluate(action({ subject: f.paymentId, amount_minor: 100_000 }));
    expect(result.verdict).toBe('ALLOW');
    expect(result.reason_code).toBe('WITHIN_GRANT');
  });

  it('blocks a 48,000 rupee refund against a 1,899 rupee claim, with the order as evidence', async () => {
    // The acceptance case. The agent asks for 48,000 rupees; the order it is
    // supposedly against was 1,899. Nothing in the request says so — we looked
    // the order up ourselves.
    const f = fixture(189_900);
    const result = await f.evaluate(action({ subject: f.paymentId, amount_minor: 4_800_000 }));

    expect(result.verdict).toBe('BLOCK');
    expect(result.reason_code).toBe('AMOUNT_ABOVE_REFUNDABLE');

    const order = result.evidence['order'] as { id: string; amount_paid_minor: number };
    expect(order.id).toBe(f.orderId);
    expect(order.amount_paid_minor).toBe(189_900);
    expect(result.evidence['requested_amount_minor']).toBe(4_800_000);
  });

  it('blocks on the order when the payment alone would have allowed it', async () => {
    // Payment is 500,000 and nothing has been refunded, so the payment does not
    // object. The resolved order does.
    const f = fixture(189_900);
    const result = await f.evaluate(action({ subject: f.paymentId, amount_minor: 400_000 }));
    expect(result.verdict).toBe('BLOCK');
    expect(result.reason_code).toBe('AMOUNT_ABOVE_ORDER');
    expect((result.evidence['order'] as { amount_paid_minor: number }).amount_paid_minor).toBe(
      189_900,
    );
  });

  it('ignores an amount the agent claims and uses the resolved one', async () => {
    const f = fixture(189_900);
    // The args say the order was worth a fortune. The args are not consulted.
    const result = await f.evaluate(
      action({
        subject: f.paymentId,
        amount_minor: 400_000,
        args: { order_amount: 10_000_000, note: 'customer says the claim was 100000' },
      }),
    );
    expect(result.verdict).toBe('BLOCK');
    expect(result.reason_code).toBe('AMOUNT_ABOVE_ORDER');
  });

  it('blocks above the granted maximum', async () => {
    const f = fixture(10_000_000);
    const result = await f.evaluate(action({ subject: f.paymentId, amount_minor: 6_000_000 }));
    expect(result.verdict).toBe('BLOCK');
    expect(result.reason_code).toBe('AMOUNT_ABOVE_GRANT');
  });

  it('blocks a currency the grant does not cover', async () => {
    const f = fixture();
    const result = await f.evaluate(
      action({ subject: f.paymentId, amount_minor: 1_000, currency: 'USD' }),
    );
    expect(result.verdict).toBe('BLOCK');
    expect(result.reason_code).toBe('CURRENCY_NOT_GRANTED');
  });

  it('blocks an unresolvable subject for an irreversible tool', async () => {
    const f = fixture();
    const result = await f.evaluate(action({ subject: 'pay_does_not_exist' }));
    expect(result.verdict).toBe('BLOCK');
    expect(result.reason_code).toBe('SUBJECT_UNRESOLVABLE');
    expect(result.evidence['on_unresolvable']).toBe('BLOCK');
  });

  it('caches a resolution rather than re-reading the rail', async () => {
    const f = fixture();
    await f.evaluate(action({ subject: f.paymentId, amount_minor: 1_000 }));
    const afterFirst = f.rail.inspect.callCount('fetchPayment');
    await f.evaluate(action({ subject: f.paymentId, amount_minor: 2_000 }));
    expect(f.rail.inspect.callCount('fetchPayment')).toBe(afterFirst);
    expect(f.resolverSize()).toBeGreaterThan(0);
  });

  it('re-reads once the 30 second window has passed', async () => {
    const rail = createMockRail({ now: () => T0 });
    const order = rail.seedOrder({ amount_minor: 500_000 });
    const payment = rail.seedPayment({ amount_minor: 500_000, order_id: order.id });
    let clock = T0;
    const resolver = createReferentResolver({ rail, now: () => clock, ttlMs: 30_000 });
    const gate = createG2Value(resolver);

    await gate.evaluate(ctx(action({ subject: payment.id, amount_minor: 1_000 })));
    const first = rail.inspect.callCount('fetchPayment');
    clock = T0 + 30_001;
    await gate.evaluate(ctx(action({ subject: payment.id, amount_minor: 1_000 })));
    expect(rail.inspect.callCount('fetchPayment')).toBe(first + 1);
  });
});
