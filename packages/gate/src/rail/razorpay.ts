import {
  InstantSettlement,
  Order,
  Payment,
  Refund,
  RefundRequest,
  type InstantSettlementRequest,
  type Page,
  type Rail,
} from './rail.js';
import {
  RailDuplicateReceiptError,
  RailNotFoundError,
  RailRejectedError,
  RailTimeoutError,
  RailUnavailableError,
} from './errors.js';

/**
 * The live Razorpay adapter.
 *
 * Three things this layer is responsible for, and nothing above it should ever
 * have to think about again:
 *
 *   1. Units. Razorpay reports timestamps in **seconds**; everything above here
 *      is epoch milliseconds. Amounts are already integer paise, so they pass
 *      through untouched — but they are parsed, not assumed.
 *
 *   2. Pagination. Razorpay pages with count/skip, not cursors. `next_cursor`
 *      is the next skip value, and it is null only when a page came back short.
 *      The reconciler treats a null cursor as proof that a listing is
 *      exhausted, so returning one early would let it conclude a refund does
 *      not exist because it stopped looking. That is the double-refund bug.
 *
 *   3. Classification. Every failure has to answer one question: might the
 *      effect have landed anyway? A timeout or a 5xx is ambiguous and must
 *      reconcile. A validation error is not, because the rail refused before
 *      acting. Getting this wrong in the safe-looking direction is how money
 *      moves twice.
 */

const BASE = 'https://api.razorpay.com/v1';

/** Razorpay's own page ceiling. */
const PAGE = 100;

export interface RazorpayOptions {
  readonly keyId: string;
  readonly keySecret: string;
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
  /** Injectable for tests. Defaults to global fetch. */
  readonly fetchImpl?: typeof fetch;
}

interface RazorpayError {
  error?: { code?: string; description?: string; reason?: string; field?: string };
}

const toMs = (seconds: unknown): number =>
  typeof seconds === 'number' && Number.isFinite(seconds) ? Math.round(seconds * 1000) : 0;

/** Razorpay notes may carry non-strings; the contract above here says strings. */
function toNotes(value: unknown): Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (raw === null || raw === undefined) continue;
    out[key] = typeof raw === 'string' ? raw : JSON.stringify(raw);
  }
  return out;
}

/**
 * Does this 400 mean "you already used that receipt"?
 *
 * Matched on the text because Razorpay does not give the case its own error
 * code. That is fragile, and it is fragile in the safe direction: a miss
 * degrades to a plain rejection, which the engine reconciles rather than
 * retries. It never turns into a second refund.
 */
function isDuplicateReceipt(body: RazorpayError): boolean {
  const text = `${body.error?.description ?? ''} ${body.error?.reason ?? ''}`.toLowerCase();
  return text.includes('receipt') && (text.includes('already') || text.includes('duplicate'));
}

export function createRazorpayRail(options: RazorpayOptions): Rail {
  const base = (options.baseUrl ?? BASE).replace(/\/+$/, '');
  const timeoutMs = options.timeoutMs ?? 20_000;
  const doFetch = options.fetchImpl ?? fetch;
  const authorization = `Basic ${Buffer.from(`${options.keyId}:${options.keySecret}`).toString('base64')}`;

  async function call(
    operation: string,
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
  ): Promise<unknown> {
    let response: Response;
    try {
      response = await doFetch(`${base}${path}`, {
        method,
        headers: {
          authorization,
          accept: 'application/json',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      // No response at all. For a write this says nothing about whether the
      // effect landed, which is precisely why it is ambiguous and not a retry.
      const name = error instanceof Error ? error.name : '';
      if (name === 'TimeoutError' || name === 'AbortError') {
        throw new RailTimeoutError(operation, null);
      }
      throw new RailUnavailableError(
        operation,
        error instanceof Error ? error.message : String(error),
        null,
      );
    }

    const text = await response.text();
    let parsed: unknown = {};
    try {
      parsed = text === '' ? {} : JSON.parse(text);
    } catch {
      parsed = {};
    }

    if (response.ok) return parsed;

    const failure = parsed as RazorpayError;
    const detail =
      failure.error?.description ?? `${operation} failed with ${String(response.status)}`;

    if (response.status === 404) {
      throw new RailNotFoundError(operation, path);
    }
    if (response.status === 408 || response.status === 504) {
      throw new RailTimeoutError(operation, response.status);
    }
    if (response.status >= 500 || response.status === 429) {
      // 429 sits here on purpose. A rate-limited write may have been accepted
      // and then throttled on the way back; treating it as a clean rejection
      // would authorise a retry of something that might already exist.
      throw new RailUnavailableError(operation, detail, response.status);
    }
    if (response.status === 400 && isDuplicateReceipt(failure)) {
      const paymentId = /\/payments\/([^/]+)\//.exec(path)?.[1] ?? '';
      const receipt = typeof (body as { receipt?: string })?.receipt === 'string'
        ? (body as { receipt: string }).receipt
        : '';
      throw new RailDuplicateReceiptError(paymentId, receipt);
    }
    throw new RailRejectedError(detail, response.status);
  }

  /**
   * One page, and an honest answer about whether there are more.
   *
   * `next_cursor` is null only when the page came back short of the limit we
   * asked for. A full page means "ask again", even if the next one turns out to
   * be empty — the alternative is guessing that a full page was the last one.
   */
  function paginate<T>(
    items: readonly T[],
    skip: number,
  ): Page<T> {
    return {
      items,
      next_cursor: items.length < PAGE ? null : String(skip + PAGE),
    };
  }

  const skipOf = (cursor: string | null | undefined): number => {
    const parsed = Number(cursor ?? 0);
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
  };

  const parseRefund = (raw: unknown): Refund => {
    const r = raw as Record<string, unknown>;
    return Refund.parse({
      id: r['id'],
      entity: 'refund',
      payment_id: r['payment_id'],
      amount_minor: r['amount'],
      currency: r['currency'],
      receipt: (r['receipt'] as string | null | undefined) ?? null,
      notes: toNotes(r['notes']),
      status: r['status'],
      speed_processed: (r['speed_processed'] as string | null | undefined) ?? null,
      // Read from the response, never computed from a rate. The rate is the
      // rail's business and it changes without telling us.
      fee_minor: (r['fee'] as number | null | undefined) ?? null,
      tax_minor: (r['tax'] as number | null | undefined) ?? null,
      created_at: toMs(r['created_at']),
    });
  };

  const parseSettlement = (raw: unknown): InstantSettlement => {
    const s = raw as Record<string, unknown>;
    return InstantSettlement.parse({
      id: s['id'],
      entity: 'settlement.ondemand',
      amount_minor: s['amount'],
      currency: (s['currency'] as string | undefined) ?? 'INR',
      fee_minor: s['fees'] ?? 0,
      tax_minor: s['tax'] ?? 0,
      amount_settled_minor: s['amount_settled'] ?? 0,
      amount_pending_minor: s['amount_pending'] ?? 0,
      amount_reversed_minor: s['amount_reversed'] ?? 0,
      settle_full_balance: Boolean(s['settle_full_balance']),
      status: s['status'],
      created_at: toMs(s['created_at']),
    });
  };

  const itemsOf = (raw: unknown): unknown[] => {
    const items = (raw as { items?: unknown }).items;
    return Array.isArray(items) ? items : [];
  };

  return {
    async createRefund(request) {
      const parsed = RefundRequest.parse(request);
      const body = {
        amount: parsed.amount_minor,
        speed: parsed.speed,
        receipt: parsed.receipt,
        notes: parsed.notes,
      };
      const raw = await call(
        'createRefund',
        'POST',
        `/payments/${encodeURIComponent(parsed.payment_id)}/refund`,
        body,
      );
      return parseRefund(raw);
    },

    async listRefundsForPayment(paymentId, cursor) {
      const skip = skipOf(cursor);
      const raw = await call(
        'listRefundsForPayment',
        'GET',
        `/payments/${encodeURIComponent(paymentId)}/refunds?count=${String(PAGE)}&skip=${String(skip)}`,
      );
      return paginate(itemsOf(raw).map(parseRefund), skip);
    },

    async listRefunds(sinceMs, cursor) {
      const skip = skipOf(cursor);
      // `from` is inclusive and in seconds. Flooring rather than rounding: a
      // rounded-up boundary can exclude the refund we are looking for.
      const from = Math.floor(sinceMs / 1000);
      const raw = await call(
        'listRefunds',
        'GET',
        `/refunds?from=${String(from)}&count=${String(PAGE)}&skip=${String(skip)}`,
      );
      return paginate(itemsOf(raw).map(parseRefund), skip);
    },

    async fetchPayment(id) {
      const raw = (await call(
        'fetchPayment',
        'GET',
        `/payments/${encodeURIComponent(id)}`,
      )) as Record<string, unknown>;
      return Payment.parse({
        id: raw['id'],
        entity: 'payment',
        amount_minor: raw['amount'],
        amount_refunded_minor: raw['amount_refunded'] ?? 0,
        currency: raw['currency'],
        status: raw['status'],
        order_id: (raw['order_id'] as string | null | undefined) ?? null,
        created_at: toMs(raw['created_at']),
      });
    },

    async fetchOrder(id) {
      const raw = (await call('fetchOrder', 'GET', `/orders/${encodeURIComponent(id)}`)) as Record<
        string,
        unknown
      >;
      return Order.parse({
        id: raw['id'],
        entity: 'order',
        amount_minor: raw['amount'],
        amount_paid_minor: raw['amount_paid'] ?? 0,
        currency: raw['currency'],
        receipt: (raw['receipt'] as string | null | undefined) ?? null,
        status: raw['status'],
        created_at: toMs(raw['created_at']),
      });
    },

    async createInstantSettlement(request: InstantSettlementRequest) {
      const raw = await call('createInstantSettlement', 'POST', '/settlements/ondemand', {
        amount: request.amount_minor,
        settle_full_balance: request.settle_full_balance ?? false,
        ...(request.description === undefined ? {} : { description: request.description }),
        notes: request.notes ?? {},
      });
      return parseSettlement(raw);
    },

    async listSettlements(sinceMs, cursor) {
      const skip = skipOf(cursor);
      const from = Math.floor(sinceMs / 1000);
      const raw = await call(
        'listSettlements',
        'GET',
        `/settlements/ondemand?from=${String(from)}&count=${String(PAGE)}&skip=${String(skip)}&expand[]=ondemand_payouts`,
      );
      return paginate(itemsOf(raw).map(parseSettlement), skip);
    },
  };
}
