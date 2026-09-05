import { describe, expect, it } from 'vitest';
import {
  RailDuplicateReceiptError,
  RailNotFoundError,
  RailRejectedError,
  RailTimeoutError,
  RailUnavailableError,
} from './errors.js';
import { PAGE_SIZE, createMockRail, type MockRail } from './mock.js';
import type { Page, Refund } from './rail.js';

const T0 = 1_757_000_000_000;

interface Harness {
  readonly rail: MockRail;
  readonly paymentId: string;
  readonly slept: number[];
  setNow(ms: number): void;
}

function harness(faults: Parameters<typeof createMockRail>[0] = {}): Harness {
  const slept: number[] = [];
  let clock = T0;
  const rail = createMockRail({
    ...faults,
    now: () => clock,
    sleep: async (ms: number) => {
      slept.push(ms);
      return Promise.resolve();
    },
  });
  const payment = rail.seedPayment({ amount_minor: 1_000_000 });
  return {
    rail,
    paymentId: payment.id,
    slept,
    setNow(ms) {
      clock = ms;
    },
  };
}

const refundArgs = (paymentId: string, n: number, amount = 10_000) => ({
  payment_id: paymentId,
  amount_minor: amount,
  receipt: `ilk_RECEIPT${String(n).padStart(4, '0')}`,
  notes: { interlock_sik: `SIK${String(n).padStart(4, '0')}` },
});

/** Walk cursors to exhaustion, the way the reconciler must. */
async function drain(
  rail: MockRail,
  paymentId: string,
): Promise<{ items: Refund[]; pages: number }> {
  const items: Refund[] = [];
  let cursor: string | null = null;
  let pages = 0;
  do {
    const page: Page<Refund> = await rail.listRefundsForPayment(paymentId, cursor);
    pages += 1;
    items.push(...page.items);
    cursor = page.next_cursor;
  } while (cursor !== null);
  return { items, pages };
}

describe('ambiguous_504: the effect applies before the response is dropped', () => {
  it('leaves the refund in upstream state after the timeout is thrown', async () => {
    const { rail, paymentId } = harness({ faults: { ambiguous_504: {} } });

    await expect(rail.createRefund(refundArgs(paymentId, 1))).rejects.toBeInstanceOf(
      RailTimeoutError,
    );

    // The caller was told nothing. The money moved anyway.
    const applied = rail.inspect.refundsForPayment(paymentId);
    expect(applied).toHaveLength(1);
    expect(applied[0]?.amount_minor).toBe(10_000);
    expect(applied[0]?.receipt).toBe('ilk_RECEIPT0001');
    expect(applied[0]?.notes['interlock_sik']).toBe('SIK0001');
  });

  it('reports the outcome as ambiguous, which is what forbids a retry', async () => {
    const { rail, paymentId } = harness({ faults: { ambiguous_504: {} } });
    await rail.createRefund(refundArgs(paymentId, 1)).catch((error: unknown) => {
      expect(error).toBeInstanceOf(RailTimeoutError);
      expect((error as RailTimeoutError).ambiguous).toBe(true);
      expect((error as RailTimeoutError).status).toBe(504);
    });
    expect.assertions(3);
  });

  it('is visible to reconciliation even though the caller never saw it', async () => {
    const { rail, paymentId } = harness({ faults: { ambiguous_504: {} } });
    await expect(rail.createRefund(refundArgs(paymentId, 1))).rejects.toBeInstanceOf(
      RailTimeoutError,
    );

    const { items } = await drain(rail, paymentId);
    expect(items).toHaveLength(1);
    expect(items[0]?.receipt).toBe('ilk_RECEIPT0001');
  });

  it('makes a naive retry hit the duplicate-receipt wall rather than double-refund', async () => {
    const { rail, paymentId } = harness({ faults: { ambiguous_504: { on_calls: [1] } } });

    await expect(rail.createRefund(refundArgs(paymentId, 1))).rejects.toBeInstanceOf(
      RailTimeoutError,
    );
    // Same meaning, same stamp: the rail refuses. This is the last line of
    // defence, not the first — the engine should never get here.
    await expect(rail.createRefund(refundArgs(paymentId, 1))).rejects.toBeInstanceOf(
      RailDuplicateReceiptError,
    );
    expect(rail.inspect.refundsForPayment(paymentId)).toHaveLength(1);
  });

  it('can be targeted at one call so later calls succeed', async () => {
    const { rail, paymentId } = harness({ faults: { ambiguous_504: { on_calls: [2] } } });
    await expect(rail.createRefund(refundArgs(paymentId, 1))).resolves.toBeDefined();
    await expect(rail.createRefund(refundArgs(paymentId, 2))).rejects.toBeInstanceOf(
      RailTimeoutError,
    );
    await expect(rail.createRefund(refundArgs(paymentId, 3))).resolves.toBeDefined();
    expect(rail.inspect.refundsForPayment(paymentId)).toHaveLength(3);
  });

  it('applies the settlement before dropping its response too', async () => {
    const { rail } = harness({ faults: { ambiguous_504: {} } });
    await expect(rail.createInstantSettlement({ amount_minor: 500_000 })).rejects.toBeInstanceOf(
      RailTimeoutError,
    );
    expect(rail.inspect.settlements()).toHaveLength(1);
  });
});

describe('pagination', () => {
  it('needs three pages to enumerate seven refunds', async () => {
    const { rail, paymentId } = harness();
    for (let i = 1; i <= 7; i += 1) {
      await rail.createRefund(refundArgs(paymentId, i));
    }

    const first = await rail.listRefundsForPayment(paymentId);
    expect(first.items).toHaveLength(3);
    expect(first.next_cursor).not.toBeNull();

    const second = await rail.listRefundsForPayment(paymentId, first.next_cursor);
    expect(second.items).toHaveLength(3);
    expect(second.next_cursor).not.toBeNull();

    const third = await rail.listRefundsForPayment(paymentId, second.next_cursor);
    expect(third.items).toHaveLength(1);
    expect(third.next_cursor).toBeNull();

    const { items, pages } = await drain(rail, paymentId);
    expect(pages).toBe(3);
    expect(items).toHaveLength(7);
    expect(PAGE_SIZE).toBe(3);
  });

  it('does not show a refund created after page one on page one', async () => {
    // Trap 1, made concrete: a reconciler that stops after page one and
    // concludes absence is wrong about four of these seven.
    const { rail, paymentId } = harness();
    for (let i = 1; i <= 7; i += 1) {
      await rail.createRefund(refundArgs(paymentId, i));
    }
    const page1 = await rail.listRefundsForPayment(paymentId);
    const onPageOne = page1.items.some((r) => r.receipt === 'ilk_RECEIPT0007');
    expect(onPageOne).toBe(false);

    const { items } = await drain(rail, paymentId);
    expect(items.some((r) => r.receipt === 'ilk_RECEIPT0007')).toBe(true);
  });

  it('exhausts in one page when there are three or fewer', async () => {
    const { rail, paymentId } = harness();
    for (let i = 1; i <= 3; i += 1) await rail.createRefund(refundArgs(paymentId, i));
    const page = await rail.listRefundsForPayment(paymentId);
    expect(page.items).toHaveLength(3);
    expect(page.next_cursor).toBeNull();
  });

  it('returns an empty exhausted page when there are none', async () => {
    const { rail, paymentId } = harness();
    const page = await rail.listRefundsForPayment(paymentId);
    expect(page.items).toHaveLength(0);
    expect(page.next_cursor).toBeNull();
  });

  it('keeps refunds for other payments out of the listing', async () => {
    const { rail, paymentId } = harness();
    const other = rail.seedPayment({ amount_minor: 500_000 });
    await rail.createRefund(refundArgs(paymentId, 1));
    await rail.createRefund(refundArgs(other.id, 2));
    const { items } = await drain(rail, paymentId);
    expect(items).toHaveLength(1);
    expect(items[0]?.payment_id).toBe(paymentId);
  });

  it('rejects a malformed cursor', async () => {
    const { rail, paymentId } = harness();
    await expect(rail.listRefundsForPayment(paymentId, 'nonsense')).rejects.toBeInstanceOf(
      RailRejectedError,
    );
  });
});

describe('duplicate receipt', () => {
  it('rejects the second use of a receipt on the same payment', async () => {
    const { rail, paymentId } = harness();
    await rail.createRefund(refundArgs(paymentId, 1));
    await expect(rail.createRefund(refundArgs(paymentId, 1))).rejects.toBeInstanceOf(
      RailDuplicateReceiptError,
    );
    expect(rail.inspect.refundsForPayment(paymentId)).toHaveLength(1);
  });

  it('rejects before applying, so the outcome is unambiguous', async () => {
    const { rail, paymentId } = harness();
    await rail.createRefund(refundArgs(paymentId, 1));
    await rail.createRefund(refundArgs(paymentId, 1)).catch((error: unknown) => {
      expect((error as RailDuplicateReceiptError).ambiguous).toBe(false);
      expect((error as RailDuplicateReceiptError).status).toBe(400);
      expect((error as RailDuplicateReceiptError).receipt).toBe('ilk_RECEIPT0001');
    });
    expect.assertions(3);
  });

  it('scopes the receipt to the payment, not globally', async () => {
    const { rail, paymentId } = harness();
    const other = rail.seedPayment({ amount_minor: 500_000 });
    await rail.createRefund(refundArgs(paymentId, 1));
    await expect(
      rail.createRefund({ ...refundArgs(paymentId, 1), payment_id: other.id }),
    ).resolves.toBeDefined();
  });

  it('records the receipt even when the response was dropped', async () => {
    const { rail, paymentId } = harness({ faults: { ambiguous_504: {} } });
    await expect(rail.createRefund(refundArgs(paymentId, 1))).rejects.toBeInstanceOf(
      RailTimeoutError,
    );
    expect(rail.inspect.receiptsForPayment(paymentId)).toEqual(['ilk_RECEIPT0001']);
  });
});

describe('slow', () => {
  it('applies the effect and then stalls past the caller timeout', async () => {
    const h = harness({ faults: { slow: { delay_ms: 45_000 } } });
    await h.rail.createRefund(refundArgs(h.paymentId, 1));
    expect(h.slept).toEqual([45_000]);
    expect(h.rail.inspect.refundsForPayment(h.paymentId)).toHaveLength(1);
  });

  it('combines with ambiguous_504: applied, stalled, then dropped', async () => {
    const h = harness({ faults: { slow: { delay_ms: 30_000 }, ambiguous_504: {} } });
    await expect(h.rail.createRefund(refundArgs(h.paymentId, 1))).rejects.toBeInstanceOf(
      RailTimeoutError,
    );
    expect(h.slept).toEqual([30_000]);
    expect(h.rail.inspect.refundsForPayment(h.paymentId)).toHaveLength(1);
  });
});

describe('dup_response', () => {
  it('applies the new refund but hands back the previous response', async () => {
    const { rail, paymentId } = harness({ faults: { dup_response: { on_calls: [2] } } });
    const first = await rail.createRefund(refundArgs(paymentId, 1));
    const second = await rail.createRefund(refundArgs(paymentId, 2));

    // The caller believes it got the first refund back.
    expect(second.id).toBe(first.id);
    expect(second.receipt).toBe('ilk_RECEIPT0001');

    // Upstream, both exist. Trusting the returned id would lose the second one,
    // which is why reconciliation matches on receipt and notes.interlock_sik.
    const applied = rail.inspect.refundsForPayment(paymentId);
    expect(applied).toHaveLength(2);
    expect(applied.map((r) => r.receipt)).toEqual(['ilk_RECEIPT0001', 'ilk_RECEIPT0002']);
    expect(applied[1]?.id).not.toBe(second.id);
  });
});

describe('partition', () => {
  it('fails reconciliation queries inside the window and recovers after it', async () => {
    const h = harness({ faults: { partition: { from_ms: T0, for_ms: 5_000 } } });
    await h.rail.createRefund(refundArgs(h.paymentId, 1));

    await expect(h.rail.listRefundsForPayment(h.paymentId)).rejects.toBeInstanceOf(
      RailUnavailableError,
    );

    h.setNow(T0 + 5_000);
    const page = await h.rail.listRefundsForPayment(h.paymentId);
    expect(page.items).toHaveLength(1);
  });

  it('does not block writes, only the reconciliation path', async () => {
    const h = harness({ faults: { partition: { from_ms: T0, for_ms: 5_000 } } });
    await expect(h.rail.createRefund(refundArgs(h.paymentId, 1))).resolves.toBeDefined();
    await expect(h.rail.listSettlements(0)).rejects.toBeInstanceOf(RailUnavailableError);
  });
});

describe('determinism and shape', () => {
  it('mints the same ids on two identical runs', async () => {
    const run = async (): Promise<string[]> => {
      const { rail, paymentId } = harness();
      const ids: string[] = [];
      for (let i = 1; i <= 3; i += 1) {
        ids.push((await rail.createRefund(refundArgs(paymentId, i))).id);
      }
      return ids;
    };
    expect(await run()).toEqual(await run());
    expect(await run()).toEqual([
      'rfnd_MOCK0000000001',
      'rfnd_MOCK0000000002',
      'rfnd_MOCK0000000003',
    ]);
  });

  it('has no destination field: a refund cannot be redirected', async () => {
    const { rail, paymentId } = harness();
    await expect(
      rail.createRefund({
        ...refundArgs(paymentId, 1),
        destination: 'acct_attacker',
      } as unknown as Parameters<MockRail['createRefund']>[0]),
    ).rejects.toThrow();
    expect(rail.inspect.refundsForPayment(paymentId)).toHaveLength(0);
  });

  it('rejects a float amount at the rail boundary', async () => {
    const { rail, paymentId } = harness();
    await expect(rail.createRefund(refundArgs(paymentId, 1, 2500.5))).rejects.toThrow();
  });

  it('rejects a receipt longer than the rail allows', async () => {
    const { rail, paymentId } = harness();
    await expect(
      rail.createRefund({ ...refundArgs(paymentId, 1), receipt: 'x'.repeat(41) }),
    ).rejects.toThrow();
  });

  it('reports fees and tax on an instant settlement as integers', async () => {
    const { rail } = harness();
    const settlement = await rail.createInstantSettlement({ amount_minor: 1_000_000 });
    expect(Number.isInteger(settlement.fee_minor)).toBe(true);
    expect(Number.isInteger(settlement.tax_minor)).toBe(true);
    expect(settlement.fee_minor).toBeGreaterThan(0);
    expect(settlement.tax_minor).toBeGreaterThan(0);
    expect(settlement.amount_settled_minor).toBe(
      settlement.amount_minor - settlement.fee_minor - settlement.tax_minor,
    );
  });

  it('leaves fees null on a normal-speed refund and reports them on optimum', async () => {
    const { rail, paymentId } = harness();
    const normal = await rail.createRefund(refundArgs(paymentId, 1));
    expect(normal.fee_minor).toBeNull();
    expect(normal.tax_minor).toBeNull();

    const optimum = await rail.createRefund({ ...refundArgs(paymentId, 2), speed: 'optimum' });
    expect(optimum.fee_minor).toBeGreaterThan(0);
    expect(optimum.tax_minor).toBeGreaterThan(0);
  });

  it('tracks the payment refunded total', async () => {
    const { rail, paymentId } = harness();
    await rail.createRefund(refundArgs(paymentId, 1, 10_000));
    await rail.createRefund(refundArgs(paymentId, 2, 25_000));
    expect((await rail.fetchPayment(paymentId)).amount_refunded_minor).toBe(35_000);
  });

  it('404s on an unknown payment or order', async () => {
    const { rail } = harness();
    await expect(rail.fetchPayment('pay_nope')).rejects.toBeInstanceOf(RailNotFoundError);
    await expect(rail.fetchOrder('order_nope')).rejects.toBeInstanceOf(RailNotFoundError);
    await expect(
      rail.createRefund(refundArgs('pay_nope', 1)),
    ).rejects.toBeInstanceOf(RailNotFoundError);
  });

  it('counts calls per operation for the chaos matrix', async () => {
    const { rail, paymentId } = harness();
    await rail.createRefund(refundArgs(paymentId, 1));
    await rail.listRefundsForPayment(paymentId);
    await rail.listRefundsForPayment(paymentId);
    expect(rail.inspect.callCount('createRefund')).toBe(1);
    expect(rail.inspect.callCount('listRefundsForPayment')).toBe(2);
    expect(rail.inspect.callCount('fetchOrder')).toBe(0);
  });

  it('resolves a seeded order', async () => {
    const { rail } = harness();
    const order = rail.seedOrder({ amount_minor: 250_000, receipt: 'order_rcpt_1' });
    expect((await rail.fetchOrder(order.id)).id).toBe('order_MOCK0000000001');
  });
});
