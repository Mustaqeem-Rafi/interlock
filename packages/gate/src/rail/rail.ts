import { Currency, EpochMs, NonNegativeMinorAmount, PositiveMinorAmount } from '@interlock/core';
import { z } from 'zod';

/**
 * The rail: everything Interlock is allowed to ask a payment API to do.
 *
 * Deliberately small. The money-out surface is exactly two calls — createRefund
 * and createInstantSettlement — and everything else is reading. If a future
 * adapter needs a third way to move money, that is a design conversation, not a
 * method you quietly add.
 *
 * Two conventions carried from CLAUDE.md, both load-bearing:
 *   - every amount is an integer in minor units, named `*_minor`;
 *   - every timestamp is epoch **milliseconds**. Razorpay reports seconds, so
 *     the razorpay adapter converts at its own boundary and nothing above it
 *     ever has to remember which unit it is holding.
 */

export const RefundSpeed = z.enum(['normal', 'optimum']);
export type RefundSpeed = z.infer<typeof RefundSpeed>;

export const RefundStatus = z.enum(['pending', 'processed', 'failed']);
export type RefundStatus = z.infer<typeof RefundStatus>;

/**
 * The refund request, and the complete list of what a refund can say.
 *
 * There is no destination field, and `strictObject` is what makes that a
 * runtime guarantee rather than a comment: a refund goes back to the instrument
 * that paid, and cannot be redirected. An agent that has been talked into
 * "refund it to this other account" cannot express the idea here.
 */
export const RefundRequest = z.strictObject({
  payment_id: z.string().min(1),
  amount_minor: PositiveMinorAmount,
  /** Razorpay caps receipts at 40 characters and treats them as per-payment keys. */
  receipt: z.string().min(1).max(40),
  notes: z.record(z.string(), z.string()).default({}),
  speed: RefundSpeed.default('normal'),
});
export type RefundRequest = z.input<typeof RefundRequest>;

export const Refund = z.strictObject({
  id: z.string().min(1),
  entity: z.literal('refund'),
  payment_id: z.string().min(1),
  amount_minor: PositiveMinorAmount,
  currency: Currency,
  receipt: z.string().nullable(),
  notes: z.record(z.string(), z.string()),
  status: RefundStatus,
  speed_processed: RefundSpeed.nullable(),
  /** Read from the response when the rail reports one. Never computed by us. */
  fee_minor: NonNegativeMinorAmount.nullable(),
  tax_minor: NonNegativeMinorAmount.nullable(),
  created_at: EpochMs,
});
export type Refund = z.infer<typeof Refund>;

export const Payment = z.strictObject({
  id: z.string().min(1),
  entity: z.literal('payment'),
  amount_minor: PositiveMinorAmount,
  amount_refunded_minor: NonNegativeMinorAmount,
  currency: Currency,
  status: z.string().min(1),
  order_id: z.string().nullable(),
  created_at: EpochMs,
});
export type Payment = z.infer<typeof Payment>;

export const Order = z.strictObject({
  id: z.string().min(1),
  entity: z.literal('order'),
  amount_minor: PositiveMinorAmount,
  amount_paid_minor: NonNegativeMinorAmount,
  currency: Currency,
  receipt: z.string().nullable(),
  status: z.string().min(1),
  created_at: EpochMs,
});
export type Order = z.infer<typeof Order>;

export const InstantSettlementRequest = z.strictObject({
  amount_minor: PositiveMinorAmount,
  settle_full_balance: z.boolean().default(false),
  description: z.string().max(30).optional(),
  notes: z.record(z.string(), z.string()).default({}),
});
export type InstantSettlementRequest = z.input<typeof InstantSettlementRequest>;

/**
 * `fee_minor` and `tax_minor` come back on the response and are the only
 * numbers Gate 3's fee budget may use. Never infer them from a rate: the rate
 * is the rail's business and it changes without telling us.
 */
export const InstantSettlement = z.strictObject({
  id: z.string().min(1),
  entity: z.literal('settlement.ondemand'),
  amount_minor: PositiveMinorAmount,
  currency: Currency,
  fee_minor: NonNegativeMinorAmount,
  tax_minor: NonNegativeMinorAmount,
  amount_settled_minor: NonNegativeMinorAmount,
  amount_pending_minor: NonNegativeMinorAmount,
  amount_reversed_minor: NonNegativeMinorAmount,
  settle_full_balance: z.boolean(),
  status: z.string().min(1),
  created_at: EpochMs,
});
export type InstantSettlement = z.infer<typeof InstantSettlement>;

/**
 * One page of a listing.
 *
 * `next_cursor` is null only when the listing is genuinely exhausted. The
 * reconciler depends on that distinction absolutely: absence on page one is not
 * absence, and CONFIRMED_NOT_APPLIED is only reachable after a pass has walked
 * cursors until this field comes back null.
 */
export interface Page<T> {
  readonly items: readonly T[];
  readonly next_cursor: string | null;
}

export interface Rail {
  /** Money out. Applies at most one refund per (payment_id, receipt). */
  createRefund(request: RefundRequest): Promise<Refund>;

  /**
   * The reconciliation query. Paginated on purpose — call it with the previous
   * page's `next_cursor` until that comes back null.
   */
  listRefundsForPayment(paymentId: string, cursor?: string | null): Promise<Page<Refund>>;

  /** Subject resolution. The id this returns is what may enter a SIK. */
  fetchPayment(id: string): Promise<Payment>;

  fetchOrder(id: string): Promise<Order>;

  /** Money out. */
  createInstantSettlement(request: InstantSettlementRequest): Promise<InstantSettlement>;

  listSettlements(sinceMs: number, cursor?: string | null): Promise<Page<InstantSettlement>>;
}

/** Named for fault targeting and call counting. */
export type RailOperation =
  | 'createRefund'
  | 'listRefundsForPayment'
  | 'fetchPayment'
  | 'fetchOrder'
  | 'createInstantSettlement'
  | 'listSettlements';

export const RAIL_OPERATIONS: readonly RailOperation[] = [
  'createRefund',
  'listRefundsForPayment',
  'fetchPayment',
  'fetchOrder',
  'createInstantSettlement',
  'listSettlements',
];
