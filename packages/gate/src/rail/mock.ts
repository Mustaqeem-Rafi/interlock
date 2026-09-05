import { z } from 'zod';
import { killAt } from '../kill-points.js';
import {
  RailDuplicateReceiptError,
  RailNotFoundError,
  RailRejectedError,
  RailTimeoutError,
  RailUnavailableError,
} from './errors.js';
import {
  InstantSettlementRequest,
  RefundRequest,
  type InstantSettlement,
  type Order,
  type Page,
  type Payment,
  type Rail,
  type RailOperation,
  type Refund,
} from './rail.js';

/**
 * An in-memory rail that can be made to fail in the specific ways that matter.
 *
 * Three properties are deliberate and none of them are conveniences:
 *
 *   1. Ids are deterministic, so a chaos trial that runs twice produces the same
 *      transcript and a diff means something.
 *   2. The page size is 3, which is smaller than any realistic result set in the
 *      scenarios. The reconciler's pagination loop is therefore genuinely
 *      exercised instead of always finding what it wants on page one — which is
 *      the failure mode that silently double-refunds.
 *   3. `inspect` reads upstream state without going through fault injection. It
 *      is the ground truth the caller is not allowed to see, and it is what the
 *      chaos matrix asserts against.
 */

/** Small on purpose. See note 2 above. */
export const PAGE_SIZE = 3;

const FaultWindow = z.strictObject({
  /**
   * 1-based indices of the calls to that operation which should fail.
   * Omit to affect every call.
   */
  on_calls: z.array(z.number().int().positive()).optional(),
});
type FaultWindow = z.infer<typeof FaultWindow>;

export const FaultConfig = z.strictObject({
  /**
   * Apply the effect upstream, then drop the response.
   *
   * This is the bug, not merely a failure. A mock that 504s without applying has
   * reproduced an error; this reproduces the ambiguity that makes the error
   * dangerous.
   */
  ambiguous_504: FaultWindow.optional(),

  /**
   * Apply the effect, then stall past the caller's timeout. The caller gives up
   * while the effect is already committed upstream — same ambiguity as a 504,
   * reached by a different route.
   */
  slow: FaultWindow.extend({ delay_ms: z.number().int().positive() }).optional(),

  /**
   * Apply the effect, then return the *previous* successful response instead of
   * this one. The caller walks away holding the wrong rail entity id, which is
   * exactly why reconciliation matches on receipt and notes.interlock_sik
   * rather than on the id it thinks it got back.
   */
  dup_response: FaultWindow.optional(),

  /**
   * Reconciliation queries fail for a window of wall-clock time.
   *
   * Scoped to the listing calls, not to writes: the point is to make a
   * reconciliation pass inconclusive so it must record STILL_UNKNOWN rather
   * than concluding absence.
   */
  partition: z
    .strictObject({
      from_ms: z.number().int().nonnegative(),
      for_ms: z.number().int().positive(),
    })
    .optional(),
});
export type FaultConfig = z.input<typeof FaultConfig>;

/** Mock-only fee model. The gate must still read fees off the response. */
export interface MockFeeModel {
  /** Basis points charged on an instant settlement. */
  readonly instant_settlement_bps: number;
  /** Basis points charged on an `optimum`-speed refund. Normal refunds are free. */
  readonly optimum_refund_bps: number;
  /** Tax on the fee, in basis points. */
  readonly tax_bps: number;
}

const DEFAULT_FEES: MockFeeModel = {
  // Arbitrary mock values. They exist so the response has numbers in it; no
  // code above the rail may assume them. Change them and nothing should break.
  instant_settlement_bps: 25,
  optimum_refund_bps: 15,
  tax_bps: 1800,
};

/**
 * Everything the mock rail holds, in a form that can be written to a file and
 * read back. The chaos matrix needs upstream state to outlive the process that
 * created it, exactly as a real rail's state does.
 */
export interface MockRailSnapshot {
  readonly payments: readonly Payment[];
  readonly orders: readonly Order[];
  readonly refunds: readonly Refund[];
  readonly settlements: readonly InstantSettlement[];
}

export type MockRailJournalEvent =
  | { readonly kind: 'refund'; readonly refund: Refund }
  | { readonly kind: 'settlement'; readonly settlement: InstantSettlement };

export interface MockRailOptions {
  readonly faults?: FaultConfig;
  /** Restore upstream state, e.g. after a restart. */
  readonly restore?: MockRailSnapshot;
  /**
   * Called synchronously the instant an effect is applied and before any
   * response or fault can intervene. Must be durable by the time it returns:
   * this models the rail committing upstream, which is the fact the whole
   * reconciler exists to discover.
   */
  readonly journal?: (event: MockRailJournalEvent) => void;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly fees?: Partial<MockFeeModel>;
  readonly currency?: string;
}

export interface SeedPaymentInput {
  readonly amount_minor: number;
  readonly currency?: string;
  readonly status?: string;
  readonly order_id?: string | null;
  readonly created_at?: number;
}

export interface SeedOrderInput {
  readonly amount_minor: number;
  readonly amount_paid_minor?: number;
  readonly currency?: string;
  readonly receipt?: string | null;
  readonly status?: string;
  readonly created_at?: number;
}

/** Upstream truth, readable without going through fault injection. */
export interface MockRailInspector {
  refunds(): readonly Refund[];
  refundsForPayment(paymentId: string): readonly Refund[];
  settlements(): readonly InstantSettlement[];
  callCount(operation: RailOperation): number;
  receiptsForPayment(paymentId: string): readonly string[];
  /** Everything upstream, serialisable. */
  snapshot(): MockRailSnapshot;
}

export interface MockRail extends Rail {
  readonly inspect: MockRailInspector;
  seedPayment(input: SeedPaymentInput): Payment;
  seedOrder(input: SeedOrderInput): Order;
}

function mockId(prefix: string, n: number): string {
  return `${prefix}_MOCK${String(n).padStart(10, '0')}`;
}

function encodeCursor(offset: number): string {
  return `c${String(offset)}`;
}

function decodeCursor(operation: string, cursor: string | null | undefined): number {
  if (cursor === null || cursor === undefined) return 0;
  const match = /^c(\d+)$/.exec(cursor);
  if (match === null) {
    throw new RailRejectedError(`${operation}: malformed cursor ${JSON.stringify(cursor)}`);
  }
  return Number.parseInt(match[1] ?? '0', 10);
}

function paginate<T>(items: readonly T[], offset: number): Page<T> {
  const slice = items.slice(offset, offset + PAGE_SIZE);
  const consumed = offset + slice.length;
  return {
    items: slice,
    // Null only when genuinely exhausted. The reconciler reads this as the
    // difference between "not here" and "not here yet".
    next_cursor: consumed < items.length ? encodeCursor(consumed) : null,
  };
}

/** Basis points of an integer minor amount, rounded down. Never a float. */
function bps(amountMinor: number, rate: number): number {
  return Math.floor((amountMinor * rate) / 10_000);
}

export function createMockRail(options: MockRailOptions = {}): MockRail {
  const faults = FaultConfig.parse(options.faults ?? {});
  const now = options.now ?? ((): number => Date.now());
  const sleep =
    options.sleep ??
    ((ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms)));
  const fees: MockFeeModel = { ...DEFAULT_FEES, ...options.fees };
  const defaultCurrency = options.currency ?? 'INR';

  const restored = options.restore;
  const payments = new Map<string, Payment>(
    (restored?.payments ?? []).map((payment) => [payment.id, payment]),
  );
  const orders = new Map<string, Order>((restored?.orders ?? []).map((order) => [order.id, order]));
  const refunds: Refund[] = [...(restored?.refunds ?? [])];
  const settlements: InstantSettlement[] = [...(restored?.settlements ?? [])];
  const receiptsByPayment = new Map<string, Set<string>>();
  for (const refund of refunds) {
    if (refund.receipt === null) continue;
    const seen = receiptsByPayment.get(refund.payment_id) ?? new Set<string>();
    seen.add(refund.receipt);
    receiptsByPayment.set(refund.payment_id, seen);
  }

  // Ids stay dense and deterministic across a restart because they are minted
  // from the count of what was restored.
  const counters = {
    payment: payments.size,
    order: orders.size,
    refund: refunds.length,
    settlement: settlements.length,
  };
  const calls: Record<RailOperation, number> = {
    createRefund: 0,
    listRefundsForPayment: 0,
    listRefunds: 0,
    fetchPayment: 0,
    fetchOrder: 0,
    createInstantSettlement: 0,
    listSettlements: 0,
  };

  let lastRefundResponse: Refund | undefined;

  const hits = (window: FaultWindow | undefined, callIndex: number): boolean => {
    if (window === undefined) return false;
    return window.on_calls === undefined || window.on_calls.includes(callIndex);
  };

  const partitioned = (): boolean => {
    const p = faults.partition;
    if (p === undefined) return false;
    const t = now();
    return t >= p.from_ms && t < p.from_ms + p.for_ms;
  };

  const applyRefund = (request: z.output<typeof RefundRequest>): Refund => {
    counters.refund += 1;
    const payment = payments.get(request.payment_id);
    const feeMinor =
      request.speed === 'optimum' ? bps(request.amount_minor, fees.optimum_refund_bps) : null;
    const refund: Refund = {
      id: mockId('rfnd', counters.refund),
      entity: 'refund',
      payment_id: request.payment_id,
      amount_minor: request.amount_minor,
      currency: payment?.currency ?? defaultCurrency,
      receipt: request.receipt,
      notes: request.notes,
      status: 'processed',
      speed_processed: request.speed,
      fee_minor: feeMinor,
      tax_minor: feeMinor === null ? null : bps(feeMinor, fees.tax_bps),
      created_at: now(),
    };
    refunds.push(refund);

    const seen = receiptsByPayment.get(request.payment_id) ?? new Set<string>();
    seen.add(request.receipt);
    receiptsByPayment.set(request.payment_id, seen);

    if (payment !== undefined) {
      payments.set(request.payment_id, {
        ...payment,
        amount_refunded_minor: payment.amount_refunded_minor + request.amount_minor,
      });
    }
    return refund;
  };

  return {
    seedPayment(input) {
      counters.payment += 1;
      const payment: Payment = {
        id: mockId('pay', counters.payment),
        entity: 'payment',
        amount_minor: input.amount_minor,
        amount_refunded_minor: 0,
        currency: input.currency ?? defaultCurrency,
        status: input.status ?? 'captured',
        order_id: input.order_id ?? null,
        created_at: input.created_at ?? now(),
      };
      payments.set(payment.id, payment);
      return payment;
    },

    seedOrder(input) {
      counters.order += 1;
      const order: Order = {
        id: mockId('order', counters.order),
        entity: 'order',
        amount_minor: input.amount_minor,
        amount_paid_minor: input.amount_paid_minor ?? input.amount_minor,
        currency: input.currency ?? defaultCurrency,
        receipt: input.receipt ?? null,
        status: input.status ?? 'paid',
        created_at: input.created_at ?? now(),
      };
      orders.set(order.id, order);
      return order;
    },

    async createRefund(request) {
      const parsed = RefundRequest.parse(request);
      calls.createRefund += 1;
      const call = calls.createRefund;

      if (!payments.has(parsed.payment_id)) {
        throw new RailNotFoundError('payment', parsed.payment_id);
      }

      // Rejected before anything is applied, so this outcome is unambiguous.
      // It is also evidence that an earlier refund carrying our stamp landed.
      if (receiptsByPayment.get(parsed.payment_id)?.has(parsed.receipt) === true) {
        throw new RailDuplicateReceiptError(parsed.payment_id, parsed.receipt);
      }

      // Died inside the request, before the rail acted on it. This is why
      // during_call legitimately ends with no refund at all.
      killAt('during_call');

      // ---------------------------------------------------------------------
      // ORDER MATTERS. The effect is applied to upstream state FIRST, and only
      // then is the response withheld.
      //
      // A mock that throws before this line has reproduced a failure. A mock
      // that throws after it has reproduced the bug: money moved, the caller
      // has no idea, and the only way back to the truth is reconciliation.
      // Every chaos result depends on this being in this order.
      // ---------------------------------------------------------------------
      const refund = applyRefund(parsed);
      options.journal?.({ kind: 'refund', refund });

      if (hits(faults.slow, call)) {
        // Applied, then stalls past the caller's timeout.
        await sleep(faults.slow?.delay_ms ?? 0);
      }

      if (hits(faults.ambiguous_504, call)) {
        throw new RailTimeoutError('createRefund');
      }

      if (hits(faults.dup_response, call) && lastRefundResponse !== undefined) {
        // The refund above is in upstream state; the caller is handed a stale body.
        return lastRefundResponse;
      }

      lastRefundResponse = refund;
      return refund;
    },

    async listRefundsForPayment(paymentId, cursor) {
      calls.listRefundsForPayment += 1;
      if (partitioned()) {
        throw new RailUnavailableError('listRefundsForPayment', 'partitioned from the rail');
      }
      if (!payments.has(paymentId)) {
        throw new RailNotFoundError('payment', paymentId);
      }
      const offset = decodeCursor('listRefundsForPayment', cursor);
      return Promise.resolve(
        paginate(
          refunds.filter((refund) => refund.payment_id === paymentId),
          offset,
        ),
      );
    },

    async listRefunds(sinceMs, cursor) {
      calls.listRefunds += 1;
      if (partitioned()) {
        throw new RailUnavailableError('listRefunds', 'partitioned from the rail');
      }
      const offset = decodeCursor('listRefunds', cursor);
      return Promise.resolve(
        paginate(
          refunds.filter((refund) => refund.created_at >= sinceMs),
          offset,
        ),
      );
    },

    async fetchPayment(id) {
      calls.fetchPayment += 1;
      const payment = payments.get(id);
      if (payment === undefined) throw new RailNotFoundError('payment', id);
      return Promise.resolve(payment);
    },

    async fetchOrder(id) {
      calls.fetchOrder += 1;
      const order = orders.get(id);
      if (order === undefined) throw new RailNotFoundError('order', id);
      return Promise.resolve(order);
    },

    async createInstantSettlement(request) {
      const parsed = InstantSettlementRequest.parse(request);
      calls.createInstantSettlement += 1;
      const call = calls.createInstantSettlement;

      counters.settlement += 1;
      const feeMinor = bps(parsed.amount_minor, fees.instant_settlement_bps);
      const settlement: InstantSettlement = {
        id: mockId('setlod', counters.settlement),
        entity: 'settlement.ondemand',
        amount_minor: parsed.amount_minor,
        currency: defaultCurrency,
        fee_minor: feeMinor,
        tax_minor: bps(feeMinor, fees.tax_bps),
        amount_settled_minor: parsed.amount_minor - feeMinor - bps(feeMinor, fees.tax_bps),
        amount_pending_minor: 0,
        amount_reversed_minor: 0,
        settle_full_balance: parsed.settle_full_balance,
        status: 'processed',
        created_at: now(),
      };
      // Applied before the response can be withheld, exactly as above.
      settlements.push(settlement);
      options.journal?.({ kind: 'settlement', settlement });

      if (hits(faults.slow, call)) {
        await sleep(faults.slow?.delay_ms ?? 0);
      }
      if (hits(faults.ambiguous_504, call)) {
        throw new RailTimeoutError('createInstantSettlement');
      }
      return settlement;
    },

    async listSettlements(sinceMs, cursor) {
      calls.listSettlements += 1;
      if (partitioned()) {
        throw new RailUnavailableError('listSettlements', 'partitioned from the rail');
      }
      const offset = decodeCursor('listSettlements', cursor);
      return Promise.resolve(
        paginate(
          settlements.filter((settlement) => settlement.created_at >= sinceMs),
          offset,
        ),
      );
    },

    inspect: {
      refunds: () => [...refunds],
      refundsForPayment: (paymentId) => refunds.filter((r) => r.payment_id === paymentId),
      settlements: () => [...settlements],
      callCount: (operation) => calls[operation],
      snapshot: () => ({
        payments: [...payments.values()],
        orders: [...orders.values()],
        refunds: [...refunds],
        settlements: [...settlements],
      }),
      receiptsForPayment: (paymentId) => [...(receiptsByPayment.get(paymentId) ?? [])],
    },
  };
}
