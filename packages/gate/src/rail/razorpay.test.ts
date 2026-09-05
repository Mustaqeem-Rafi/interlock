import { describe, expect, it } from 'vitest';
import {
  RailDuplicateReceiptError,
  RailNotFoundError,
  RailRejectedError,
  RailTimeoutError,
  RailUnavailableError,
} from './errors.js';
import { createRazorpayRail } from './razorpay.js';

/**
 * The adapter, against a stubbed transport.
 *
 * These do not prove Razorpay behaves as described — only a live probe can do
 * that, and docs/rail-notes.md records what it found. What they pin is the part
 * that is ours: units, pagination, and above all the classification of a
 * failure into "the effect may have landed" or "it certainly did not". That
 * last one is what I3 turns on, and getting it wrong in the comfortable
 * direction is how a refund happens twice.
 */

type Handler = (url: string, init: RequestInit) => { status: number; body: unknown };

function railWith(handler: Handler): ReturnType<typeof createRazorpayRail> {
  return createRazorpayRail({
    keyId: 'rzp_test_stub',
    keySecret: 'stub-secret',
    fetchImpl: ((url: string, init: RequestInit) => {
      const { status, body } = handler(String(url), init);
      return Promise.resolve(
        new Response(JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }) as unknown as typeof fetch,
  });
}

const REFUND = {
  id: 'rfnd_TEST01',
  payment_id: 'pay_TEST01',
  amount: 189_900,
  currency: 'INR',
  receipt: 'ilk_ABCDEF',
  notes: { interlock_sik: 'ABCDEF' },
  status: 'processed',
  speed_processed: 'normal',
  fee: 0,
  tax: 0,
  created_at: 1_757_000_100,
};

describe('razorpay adapter: units', () => {
  it('converts seconds to milliseconds at this boundary and nowhere else', async () => {
    const rail = railWith(() => ({ status: 200, body: REFUND }));
    const refund = await rail.createRefund({
      payment_id: 'pay_TEST01',
      amount_minor: 189_900,
      receipt: 'ilk_ABCDEF',
    });
    // 1_757_000_100 seconds is the epoch second Razorpay reports. Anything
    // above this adapter is entitled to assume milliseconds.
    expect(refund.created_at).toBe(1_757_000_100_000);
    expect(refund.amount_minor).toBe(189_900);
  });

  it('reads fee and tax off the response rather than computing them', async () => {
    const rail = railWith(() => ({ status: 200, body: { ...REFUND, fee: 472, tax: 85 } }));
    const refund = await rail.createRefund({
      payment_id: 'pay_TEST01',
      amount_minor: 189_900,
      receipt: 'ilk_ABCDEF',
    });
    expect(refund.fee_minor).toBe(472);
    expect(refund.tax_minor).toBe(85);
  });

  it('sends the receipt, because the stamp is what makes reconciliation possible', async () => {
    let sent: Record<string, unknown> = {};
    const rail = railWith((_url, init) => {
      sent = JSON.parse(String(init.body)) as Record<string, unknown>;
      return { status: 200, body: REFUND };
    });
    await rail.createRefund({
      payment_id: 'pay_TEST01',
      amount_minor: 189_900,
      receipt: 'ilk_ABCDEF',
      notes: { interlock_sik: 'ABCDEF' },
    });
    expect(sent['receipt']).toBe('ilk_ABCDEF');
    expect(sent['notes']).toEqual({ interlock_sik: 'ABCDEF' });
    // There is no destination field to send, and RefundRequest is a strict
    // object, so an agent cannot smuggle one in.
    expect(Object.keys(sent).sort()).toEqual(['amount', 'notes', 'receipt', 'speed']);
  });
});

describe('razorpay adapter: pagination', () => {
  it('offers a next cursor while a page comes back full', async () => {
    const rail = railWith(() => ({
      status: 200,
      body: { items: Array.from({ length: 100 }, () => REFUND) },
    }));
    const page = await rail.listRefundsForPayment('pay_TEST01');
    expect(page.items).toHaveLength(100);
    expect(page.next_cursor).toBe('100');
  });

  it('reports exhaustion only when a page comes back short', async () => {
    // The reconciler treats a null cursor as proof that a listing is finished.
    // Returning one while more pages exist is how it concludes a refund does
    // not exist because it stopped looking.
    const rail = railWith(() => ({ status: 200, body: { items: [REFUND] } }));
    expect((await rail.listRefundsForPayment('pay_TEST01')).next_cursor).toBeNull();
  });

  it('an empty page is exhaustion, not an error', async () => {
    const rail = railWith(() => ({ status: 200, body: { items: [] } }));
    const page = await rail.listRefundsForPayment('pay_TEST01');
    expect(page.items).toHaveLength(0);
    expect(page.next_cursor).toBeNull();
  });

  it('walks skip forward from the cursor it was given', async () => {
    let seen = '';
    const rail = railWith((url) => {
      seen = url;
      return { status: 200, body: { items: [] } };
    });
    await rail.listRefundsForPayment('pay_TEST01', '200');
    expect(seen).toContain('skip=200');
  });
});

describe('razorpay adapter: might the effect have landed?', () => {
  const attempt = (rail: ReturnType<typeof createRazorpayRail>): Promise<unknown> =>
    rail.createRefund({ payment_id: 'pay_TEST01', amount_minor: 100, receipt: 'ilk_X' });

  it('a 5xx is ambiguous — it reconciles, it never retries', async () => {
    const rail = railWith(() => ({ status: 502, body: { error: { description: 'bad gateway' } } }));
    await expect(attempt(rail)).rejects.toBeInstanceOf(RailUnavailableError);
    await expect(attempt(rail)).rejects.toMatchObject({ ambiguous: true });
  });

  it('a 504 is ambiguous', async () => {
    const rail = railWith(() => ({ status: 504, body: {} }));
    await expect(attempt(rail)).rejects.toBeInstanceOf(RailTimeoutError);
    await expect(attempt(rail)).rejects.toMatchObject({ ambiguous: true });
  });

  it('a 429 is ambiguous, because a throttled write may already have been accepted', async () => {
    const rail = railWith(() => ({ status: 429, body: { error: { description: 'too many' } } }));
    await expect(attempt(rail)).rejects.toMatchObject({ ambiguous: true });
  });

  it('a transport failure with no response is ambiguous', async () => {
    const rail = createRazorpayRail({
      keyId: 'rzp_test_stub',
      keySecret: 'stub',
      // A transport that never answers. The DOMException name is what node's
      // fetch actually throws on a dropped connection, and the adapter keys off
      // the name rather than the class.
      fetchImpl: (() =>
        Promise.reject(new DOMException('ECONNRESET', 'NetworkError'))) as unknown as typeof fetch,
    });
    await expect(attempt(rail)).rejects.toMatchObject({ ambiguous: true });
  });

  it('a validation error is not ambiguous — the rail refused before acting', async () => {
    const rail = railWith(() => ({
      status: 400,
      body: { error: { description: 'The amount exceeds the refundable amount' } },
    }));
    await expect(attempt(rail)).rejects.toBeInstanceOf(RailRejectedError);
    await expect(attempt(rail)).rejects.toMatchObject({ ambiguous: false });
  });

  it('a 404 is not ambiguous', async () => {
    const rail = railWith(() => ({ status: 404, body: { error: { description: 'no such' } } }));
    await expect(rail.fetchPayment('pay_NOPE')).rejects.toBeInstanceOf(RailNotFoundError);
  });
});

describe('razorpay adapter: the receipt already exists', () => {
  it('is recognised as evidence, not as a generic rejection', async () => {
    // Positive evidence that an earlier refund carrying our stamp landed. The
    // engine reconciles on the receipt rather than treating this as a 400.
    const rail = railWith(() => ({
      status: 400,
      body: {
        error: {
          code: 'BAD_REQUEST_ERROR',
          description: 'Receipt has already been used for this payment',
        },
      },
    }));
    const failure = await rail
      .createRefund({ payment_id: 'pay_TEST01', amount_minor: 100, receipt: 'ilk_STAMP' })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(RailDuplicateReceiptError);
    expect(failure).toMatchObject({ payment_id: 'pay_TEST01', receipt: 'ilk_STAMP' });
  });

  it('degrades to a plain rejection when the wording is not recognised', async () => {
    // Matched on text because Razorpay gives this case no code of its own. A
    // miss must fail towards reconciliation, never towards a retry.
    const rail = railWith(() => ({
      status: 400,
      body: { error: { description: 'something new nobody has seen' } },
    }));
    const failure = await rail
      .createRefund({ payment_id: 'pay_TEST01', amount_minor: 100, receipt: 'ilk_STAMP' })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(RailRejectedError);
    expect(failure).toMatchObject({ ambiguous: false });
  });
});
