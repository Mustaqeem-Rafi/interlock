import { describe, expect, it } from 'vitest';
import { InvariantViolation } from './errors.js';
import {
  SIK_LENGTH,
  computeSik,
  railSubjectId,
  sikPayload,
  sikReceipt,
  timeWindow,
  type SikInput,
} from './sik.js';

const PAYMENT = railSubjectId('pay_MkT9xQr2LbVc41');

const REFUND: SikInput = {
  merchant_id: 'acc_KtqXyZ01',
  tool: 'create_refund',
  subject: PAYMENT,
  amount_minor: 250_000,
  currency: 'INR',
};

describe('computeSik: shape', () => {
  it('is 32 characters of base32', () => {
    const sik = computeSik(REFUND);
    expect(sik).toHaveLength(SIK_LENGTH);
    expect(sik).toMatch(/^[A-Z2-7]{32}$/);
  });

  it('stamps a receipt that fits the 40-character rail budget', () => {
    expect(sikReceipt(computeSik(REFUND))).toMatch(/^ilk_[A-Z2-7]{32}$/);
    expect(sikReceipt(computeSik(REFUND)).length).toBeLessThanOrEqual(40);
  });

  it('hashes exactly the nine documented fields', () => {
    expect(Object.keys(sikPayload(REFUND)).sort()).toEqual([
      'amount_minor',
      'currency',
      'distinct',
      'extra',
      'merchant_id',
      'subject',
      'tool',
      'v',
      'window',
    ]);
  });
});

describe('computeSik: stability', () => {
  it('is stable across argument order', () => {
    const a: SikInput = {
      merchant_id: 'acc_KtqXyZ01',
      tool: 'create_refund',
      subject: PAYMENT,
      amount_minor: 250_000,
      currency: 'INR',
      extra: { payment_id: 'pay_MkT9xQr2LbVc41', speed: 'normal' },
    };
    const b: SikInput = {
      extra: { speed: 'normal', payment_id: 'pay_MkT9xQr2LbVc41' },
      currency: 'INR',
      amount_minor: 250_000,
      subject: PAYMENT,
      tool: 'create_refund',
      merchant_id: 'acc_KtqXyZ01',
    };

    expect(computeSik(a)).toBe(computeSik(b));
  });

  it('treats an omitted optional and an explicit null as the same thing', () => {
    expect(computeSik(REFUND)).toBe(
      computeSik({ ...REFUND, extra: null, window: null, distinct: null }),
    );
  });

  it('does not drift between calls', () => {
    expect(computeSik(REFUND)).toBe(computeSik({ ...REFUND }));
  });
});

describe('computeSik: two identical refunds collide', () => {
  it('collides for the same payment, amount and currency', () => {
    const first = computeSik(REFUND);
    const second = computeSik({
      merchant_id: 'acc_KtqXyZ01',
      tool: 'create_refund',
      subject: railSubjectId('pay_MkT9xQr2LbVc41'),
      currency: 'INR',
      amount_minor: 250_000,
    });
    expect(second).toBe(first);
  });

  it('still collides when the model rephrases the request', () => {
    // Same resolved payment, different wording in the agent's arguments. The
    // wording never reaches the key, so the retry is caught.
    expect(computeSik({ ...REFUND, extra: null })).toBe(computeSik(REFUND));
  });

  it('separates a different payment, amount, currency, tool or merchant', () => {
    const base = computeSik(REFUND);
    expect(computeSik({ ...REFUND, subject: railSubjectId('pay_other') })).not.toBe(base);
    expect(computeSik({ ...REFUND, amount_minor: 250_001 })).not.toBe(base);
    expect(computeSik({ ...REFUND, currency: 'USD' })).not.toBe(base);
    expect(computeSik({ ...REFUND, tool: 'create_instant_settlement' })).not.toBe(base);
    expect(computeSik({ ...REFUND, merchant_id: 'acc_other' })).not.toBe(base);
  });
});

describe('computeSik: the distinct-reason escape hatch', () => {
  it('separates two otherwise identical refunds', () => {
    expect(computeSik({ ...REFUND, distinct: 'second item returned separately' })).not.toBe(
      computeSik(REFUND),
    );
  });

  it('enters the key verbatim, with no normalisation', () => {
    expect(computeSik({ ...REFUND, distinct: 'Second Item' })).not.toBe(
      computeSik({ ...REFUND, distinct: 'second item' }),
    );
    expect(computeSik({ ...REFUND, distinct: ' second item ' })).not.toBe(
      computeSik({ ...REFUND, distinct: 'second item' }),
    );
  });
});

describe('computeSik: rejections', () => {
  it('rejects a float amount', () => {
    expect(() => computeSik({ ...REFUND, amount_minor: 2500.5 })).toThrow(InvariantViolation);
  });

  it('rejects a non-ISO currency', () => {
    expect(() => computeSik({ ...REFUND, currency: 'inr' })).toThrow(InvariantViolation);
    expect(() => computeSik({ ...REFUND, currency: 'RUPEE' })).toThrow(InvariantViolation);
  });

  it('rejects an empty subject at the branding boundary', () => {
    expect(() => railSubjectId('   ')).toThrow(InvariantViolation);
  });

  it('refuses a time window on create_refund', () => {
    expect(() =>
      computeSik({ ...REFUND, window: { window_ms: 86_400_000, bucket: 1 } }),
    ).toThrow(InvariantViolation);
  });
});

describe('timeWindow', () => {
  it('returns null when the tool has no window', () => {
    expect(timeWindow(1_757_000_000_000, null)).toBeNull();
  });

  it('buckets a timestamp and carries the window size into the key', () => {
    expect(timeWindow(3_600_500, 3_600_000)).toEqual({ window_ms: 3_600_000, bucket: 1 });
  });

  it('collides within a bucket and separates across one', () => {
    const tool = 'fetch_payment';
    const at = (nowMs: number): string =>
      computeSik({ ...REFUND, tool, window: timeWindow(nowMs, 3_600_000) });

    expect(at(3_600_000)).toBe(at(7_199_999));
    expect(at(3_600_000)).not.toBe(at(7_200_000));
  });

  it('changing the mandate window invalidates old keys', () => {
    const tool = 'fetch_payment';
    const a = computeSik({ ...REFUND, tool, window: timeWindow(0, 3_600_000) });
    const b = computeSik({ ...REFUND, tool, window: timeWindow(0, 7_200_000) });
    expect(a).not.toBe(b);
  });

  it('rejects a non-positive or fractional window', () => {
    expect(() => timeWindow(0, 0)).toThrow(InvariantViolation);
    expect(() => timeWindow(0, 1.5)).toThrow(InvariantViolation);
    expect(() => timeWindow(-1, 1000)).toThrow(InvariantViolation);
  });
});
