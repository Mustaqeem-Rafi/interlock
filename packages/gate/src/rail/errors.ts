import { InterlockError } from '@interlock/core';

/**
 * Rail failures, classified by the only question the engine actually needs
 * answered: might the effect have landed anyway?
 *
 * I3 turns on this and nothing else. A timeout or a 5xx never retries — it
 * reconciles — because `ambiguous` is true and we genuinely do not know. A 404
 * or a rejected argument is safe to treat as "nothing happened", because the
 * rail told us so before doing anything.
 */
export abstract class RailError extends InterlockError {
  /** HTTP status, or null when the response never arrived. */
  abstract readonly status: number | null;

  /**
   * True when this call may have applied upstream despite failing.
   * Never retry one of these. Reconcile it.
   */
  abstract readonly ambiguous: boolean;
}

/**
 * The response never arrived. Says nothing whatsoever about whether the effect
 * landed — which is the entire point of the ambiguous_504 fault.
 */
export class RailTimeoutError extends RailError {
  readonly code = 'RAIL_TIMEOUT' as const;
  readonly status: number | null;
  readonly ambiguous = true as const;

  constructor(operation: string, status: number | null = 504) {
    super(`${operation} timed out; the effect may or may not have been applied`);
    this.status = status;
  }
}

/** The rail could not be reached, or refused to serve. Also ambiguous for writes. */
export class RailUnavailableError extends RailError {
  readonly code = 'RAIL_UNAVAILABLE' as const;
  readonly status: number | null;
  readonly ambiguous = true as const;

  constructor(operation: string, detail: string, status: number | null = 503) {
    super(`${operation} unavailable: ${detail}`);
    this.status = status;
  }
}

/**
 * The receipt has already been used on this payment.
 *
 * This is not just a rejection — it is positive evidence that an earlier refund
 * with our stamp landed. The engine should reconcile on the receipt rather than
 * treat it as a generic 400.
 */
export class RailDuplicateReceiptError extends RailError {
  readonly code = 'RAIL_DUPLICATE_RECEIPT' as const;
  readonly status = 400 as const;
  readonly ambiguous = false as const;
  readonly payment_id: string;
  readonly receipt: string;

  constructor(paymentId: string, receipt: string) {
    super(
      `receipt "${receipt}" has already been used on payment ${paymentId}; ` +
        `an earlier refund with this stamp exists`,
    );
    this.payment_id = paymentId;
    this.receipt = receipt;
  }
}

export class RailNotFoundError extends RailError {
  readonly code = 'RAIL_NOT_FOUND' as const;
  readonly status = 404 as const;
  readonly ambiguous = false as const;

  constructor(entity: string, id: string) {
    super(`no ${entity} with id ${id}`);
  }
}

/** The rail refused the request before acting on it. */
export class RailRejectedError extends RailError {
  readonly code = 'RAIL_REJECTED' as const;
  readonly status: number | null;
  readonly ambiguous = false as const;

  constructor(detail: string, status: number | null = 400) {
    super(detail);
    this.status = status;
  }
}
