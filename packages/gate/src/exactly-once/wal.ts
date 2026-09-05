import { randomUUID } from 'node:crypto';
import { InvariantViolation, sikReceipt, type AttemptOutcome } from '@interlock/core';
import type { IntentRow, Store } from '@interlock/store';
import { killAt } from '../kill-points.js';
import { RailDuplicateReceiptError, RailError } from '../rail/errors.js';
import type { Rail, Refund, RefundRequest, RefundSpeed } from '../rail/rail.js';
import { assertMayIssueRailCall, nextState } from './machine.js';

/**
 * The write-ahead intent log.
 *
 * Two jobs, and they are the same job seen from two sides:
 *
 *   1. Nothing reaches the rail until an IN_FLIGHT row is durable on disk. The
 *      store commits with synchronous = FULL, so startAttempt only returns after
 *      the fsync — which means the sequencing here *is* invariant I2. There is
 *      no window in which money can move without a record saying it might have.
 *
 *   2. Every outbound refund carries our stamp. Reconciliation matches on
 *      receipt and notes.interlock_sik and on nothing else, because amount is
 *      not an identity. An unstamped refund is invisible to the reconciler, so
 *      issuing one would silently break exactly-once for that intent.
 *
 * The second is enforced structurally rather than by discipline. Look at
 * RefundOrder: there is no receipt field to fill in, and no amount or payment
 * either — those come off the durable intent row. A caller cannot issue an
 * unstamped refund because a caller cannot construct the request at all.
 */

/** Long enough to outlive a slow rail call, short enough that recovery is quick. */
export const LEASE_MS = 30_000;

/** One id per process, so a sweep can tell our stale leases from someone else's. */
const PROCESS_OWNER = randomUUID();

/**
 * What a caller may say about a refund.
 *
 * Note what is missing: receipt, amount_minor and payment_id. The stamp is not
 * optional and the money is not the caller's to restate — both are read from
 * the intent row that the primary key already made unique.
 */
export interface RefundOrder {
  readonly speed?: RefundSpeed;
  /** Merged under the stamp. `interlock_sik` cannot be overridden. */
  readonly notes?: Readonly<Record<string, string>>;
}

/**
 * Build the stamped request. Exported so the stamping rule can be tested
 * directly, and so a reader can see in six lines what the reconciler depends on.
 */
export function stampRefund(
  sik: string,
  subjectId: string,
  amountMinor: number,
  order: RefundOrder = {},
): RefundRequest {
  return {
    payment_id: subjectId,
    amount_minor: amountMinor,
    speed: order.speed ?? 'normal',
    receipt: sikReceipt(sik),
    // interlock_sik is spread last on purpose: caller notes can sit beside the
    // stamp but can never replace it.
    notes: { ...order.notes, interlock_sik: sik },
  };
}

/** Belt to the type system's braces, checked on the last line before the wire. */
export function assertStamped(request: RefundRequest, sik: string): void {
  if (request.receipt !== sikReceipt(sik)) {
    throw new InvariantViolation(
      'wal.stamp',
      `refund receipt is ${JSON.stringify(request.receipt)}, expected ${sikReceipt(sik)}`,
    );
  }
  if (request.notes?.['interlock_sik'] !== sik) {
    throw new InvariantViolation(
      'wal.stamp',
      'refund notes are missing interlock_sik; the reconciler could not find this refund',
    );
  }
}

export type IssueOutcome =
  | { readonly kind: 'APPLIED'; readonly refund: Refund; readonly intent: IntentRow }
  | { readonly kind: 'FAILED_TERMINAL'; readonly error: RailError; readonly intent: IntentRow }
  | { readonly kind: 'UNKNOWN'; readonly error: unknown; readonly intent: IntentRow };

export interface WalOptions {
  readonly store: Store;
  readonly rail: Rail;
  readonly now?: () => number;
  readonly owner?: string;
  readonly leaseMs?: number;
}

export interface Wal {
  readonly owner: string;
  /**
   * Commit an IN_FLIGHT row, then issue exactly one refund against the rail.
   * Never called twice for the same attempt: the store's compare-and-set from
   * AUTHORIZED is what makes a second caller lose.
   */
  issueRefund(intent: IntentRow, order?: RefundOrder): Promise<IssueOutcome>;
  /** IN_FLIGHT rows whose lease has lapsed, for the recovery sweep. */
  expiredLeases(limit?: number): readonly IntentRow[];
}

/** Classify a thrown value into the state the machine should move to. */
function outcomeFor(error: unknown): {
  event: 'RAIL_REJECTED' | 'RAIL_AMBIGUOUS';
  attempt: AttemptOutcome;
} {
  if (error instanceof RailDuplicateReceiptError) {
    // The rail is telling us a refund carrying our stamp already exists. That is
    // evidence, not a failure — but we do not have the entity id, so the honest
    // state is UNKNOWN and the reconciler will find it by receipt.
    return { event: 'RAIL_AMBIGUOUS', attempt: 'AMBIGUOUS' };
  }
  if (error instanceof RailError) {
    return error.ambiguous
      ? { event: 'RAIL_AMBIGUOUS', attempt: error.status === null ? 'TIMEOUT' : 'AMBIGUOUS' }
      : { event: 'RAIL_REJECTED', attempt: 'FAILED' };
  }
  // An unexpected throw. We do not know whether the request left the process,
  // so we assume it might have. Never optimistic here.
  return { event: 'RAIL_AMBIGUOUS', attempt: 'AMBIGUOUS' };
}

export function createWal(options: WalOptions): Wal {
  const { store, rail } = options;
  const now = options.now ?? ((): number => Date.now());
  const owner = options.owner ?? PROCESS_OWNER;
  const leaseMs = options.leaseMs ?? LEASE_MS;

  return {
    owner,

    async issueRefund(intent, order = {}) {
      // Refuse before touching disk if this intent is not in the one state a
      // rail call may leave from.
      assertMayIssueRailCall(intent.state);

      const request = stampRefund(intent.sik, intent.subject_id, intent.amount_minor, order);
      assertStamped(request, intent.sik);

      killAt('before_wal');

      // ---------------------------------------------------------------------
      // I2. This call writes the IN_FLIGHT row, the attempt row and the audit
      // record in one transaction, on a connection running synchronous = FULL.
      // It returns only after that transaction is fsynced. Nothing below this
      // line can move money without a durable record that it might have.
      //
      // The rail call MUST stay after this. If you find yourself moving it up
      // for latency, you are removing the guarantee, not optimising it.
      // ---------------------------------------------------------------------
      const started = store.intents.startAttempt({
        merchant_id: intent.merchant_id,
        sik: intent.sik,
        from: 'AUTHORIZED',
        at: now(),
        request,
        lease_owner: owner,
        lease_ms: leaseMs,
      });
      const attemptSeq = started.attempt.attempt_seq;

      killAt('after_wal_before_call');

      try {
        // The rail adapter fires `during_call` from inside the request.
        const refund = await rail.createRefund(request);

        killAt('after_call_before_commit');

        store.intents.finishAttempt({
          merchant_id: intent.merchant_id,
          sik: intent.sik,
          attempt_seq: attemptSeq,
          at: now(),
          outcome: 'APPLIED',
          rail_entity_id: refund.id,
          http_status: 200,
          fee_minor: refund.fee_minor,
          tax_minor: refund.tax_minor,
          response: refund,
        });

        const applied = store.intents.transition({
          merchant_id: intent.merchant_id,
          sik: intent.sik,
          from: 'IN_FLIGHT',
          to: nextState('IN_FLIGHT', 'RAIL_APPLIED'),
          at: now(),
          rail_entity_id: refund.id,
          lease: null,
          audit_kind: 'RAIL_APPLIED',
          audit_payload: { attempt_seq: attemptSeq, rail_entity_id: refund.id },
        });

        killAt('after_commit_before_ack');

        return { kind: 'APPLIED', refund, intent: applied };
      } catch (error) {
        const { event, attempt } = outcomeFor(error);

        store.intents.finishAttempt({
          merchant_id: intent.merchant_id,
          sik: intent.sik,
          attempt_seq: attemptSeq,
          at: now(),
          outcome: attempt,
          http_status: error instanceof RailError ? error.status : null,
          error_code: error instanceof RailError ? error.code : 'UNEXPECTED',
        });

        const moved = store.intents.transition({
          merchant_id: intent.merchant_id,
          sik: intent.sik,
          from: 'IN_FLIGHT',
          to: nextState('IN_FLIGHT', event),
          at: now(),
          lease: null,
          audit_kind: event,
          audit_payload: {
            attempt_seq: attemptSeq,
            error_code: error instanceof RailError ? error.code : 'UNEXPECTED',
            ambiguous: event === 'RAIL_AMBIGUOUS',
          },
        });

        if (event === 'RAIL_REJECTED') {
          return { kind: 'FAILED_TERMINAL', error: error as RailError, intent: moved };
        }
        return { kind: 'UNKNOWN', error, intent: moved };
      }
    },

    expiredLeases(limit = 100) {
      return store.intents.sweepExpiredLeases(now(), { limit });
    },
  };
}
