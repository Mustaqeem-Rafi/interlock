import { sikReceipt, type ReconOutcome } from '@interlock/core';
import type { IntentRow, Store } from '@interlock/store';
import type { Page, Rail, Refund } from '../rail/rail.js';
import { nextState } from './machine.js';

/**
 * The ambiguous-response protocol.
 *
 * A timeout, a 5xx or a socket error puts the intent in UNKNOWN and it stays
 * there. It is never retried, because "we did not hear back" and "it did not
 * happen" are different statements and only one of them is true. The way out of
 * UNKNOWN is to go and look.
 *
 * Three traps sit in that lookup, and each one silently double-refunds if
 * missed. They are the reason this file is longer than it looks like it should
 * be:
 *
 *   1. Absence on page one is not absence. CONFIRMED_NOT_APPLIED — the only
 *      state a retry may leave from — is reachable only when a single pass
 *      walked cursors until next_cursor came back null and found nothing.
 *      Anything less is STILL_UNKNOWN.
 *
 *   2. The rail is not read-your-writes. Querying the instant after a call can
 *      report absent for something that applied. So the first query of the
 *      first pass waits RECONCILE_MIN_DELAY_MS after the attempt ended.
 *
 *   3. Amount is not an identity. Two refunds of Rs 3,400 against one payment
 *      are indistinguishable by amount, so matching is on receipt or
 *      notes.interlock_sik and on nothing else. That is what the stamp is for.
 */

/** Trap 2. Two seconds is a guess about replication lag, and it is a floor. */
export const RECONCILE_MIN_DELAY_MS = 2_000;

/** After this many inconclusive passes, a human is the correct answer. */
export const MAX_RECONCILE_ATTEMPTS = 6;

/** Backoff is 2^n seconds, capped here. */
export const MAX_BACKOFF_SECONDS = 60;

export function backoffMs(attempt: number, capSeconds = MAX_BACKOFF_SECONDS): number {
  return Math.min(2 ** attempt, capSeconds) * 1_000;
}

/**
 * Trap 3. Identity is the stamp, never the amount.
 *
 * `notes.interlock_sik` is checked first because notes survive more of the
 * rail's own normalisation than receipts do, but either is proof.
 */
export function matchesSik(refund: Refund, sik: string): boolean {
  return refund.notes['interlock_sik'] === sik || refund.receipt === sikReceipt(sik);
}

/** Recover the sik a rail entity is carrying, if it carries one at all. */
export function sikOf(refund: Refund): string | null {
  const fromNotes = refund.notes['interlock_sik'];
  if (typeof fromNotes === 'string' && fromNotes !== '') return fromNotes;
  const receipt = refund.receipt;
  if (receipt !== null && receipt.startsWith('ilk_')) return receipt.slice('ilk_'.length);
  return null;
}

/**
 * The result of one walk of the rail's pagination.
 *
 * EXHAUSTED_NO_MATCH is deliberately a different shape from INCOMPLETE. They
 * are the two outcomes it is fatal to confuse, so the type does not let you
 * reach for one and get the other.
 */
export type ScanResult =
  | { readonly status: 'FOUND'; readonly refund: Refund; readonly pages: number }
  | { readonly status: 'EXHAUSTED_NO_MATCH'; readonly pages: number }
  | { readonly status: 'INCOMPLETE'; readonly pages: number; readonly error: unknown };

/** Trap 1. Walks cursors until next_cursor is null, or reports that it could not. */
export async function scanForSik(
  rail: Rail,
  paymentId: string,
  sik: string,
): Promise<ScanResult> {
  let cursor: string | null = null;
  let pages = 0;
  try {
    for (;;) {
      const page: Page<Refund> = await rail.listRefundsForPayment(paymentId, cursor);
      pages += 1;
      const hit = page.items.find((refund) => matchesSik(refund, sik));
      if (hit !== undefined) return { status: 'FOUND', refund: hit, pages };
      cursor = page.next_cursor;
      // The one line that makes CONFIRMED_NOT_APPLIED honest.
      if (cursor === null) return { status: 'EXHAUSTED_NO_MATCH', pages };
    }
  } catch (error) {
    return { status: 'INCOMPLETE', pages, error };
  }
}

export type ReconcileOutcome =
  | { readonly kind: 'APPLIED'; readonly intent: IntentRow; readonly rail_entity_id: string }
  | { readonly kind: 'CONFIRMED_NOT_APPLIED'; readonly intent: IntentRow }
  | {
      readonly kind: 'STILL_UNKNOWN';
      readonly intent: IntentRow;
      readonly attempts: number;
      readonly retry_after_ms: number;
    }
  | { readonly kind: 'QUARANTINED'; readonly intent: IntentRow; readonly attempts: number }
  /** Already terminal when we looked. Nothing to do. */
  | { readonly kind: 'SETTLED'; readonly intent: IntentRow };

export interface ReconcilerOptions {
  readonly store: Store;
  readonly rail: Rail;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly minDelayMs?: number;
  readonly maxAttempts?: number;
  readonly maxBackoffSeconds?: number;
  readonly owner?: string;
  readonly leaseMs?: number;
}

export interface Reconciler {
  /** One pass. Exactly one recon_findings row and one state change. */
  reconcile(intent: IntentRow): Promise<ReconcileOutcome>;
  /** Passes with backoff until the intent settles or is quarantined. */
  settle(intent: IntentRow): Promise<ReconcileOutcome>;
}

const TERMINAL = new Set(['APPLIED', 'BLOCKED', 'CONFIRMED_NOT_APPLIED', 'QUARANTINED']);

export function createReconciler(options: ReconcilerOptions): Reconciler {
  const { store, rail } = options;
  const now = options.now ?? ((): number => Date.now());
  const sleep =
    options.sleep ??
    ((ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms)));
  const minDelayMs = options.minDelayMs ?? RECONCILE_MIN_DELAY_MS;
  const maxAttempts = options.maxAttempts ?? MAX_RECONCILE_ATTEMPTS;
  const capSeconds = options.maxBackoffSeconds ?? MAX_BACKOFF_SECONDS;
  const owner = options.owner ?? 'reconciler';
  const leaseMs = options.leaseMs ?? 30_000;

  /** Trap 2: never query before the rail has had a chance to become consistent. */
  async function waitForReadYourWrites(intent: IntentRow): Promise<void> {
    const attempts = store.intents.attempts(intent.merchant_id, intent.sik);
    const last = attempts.at(-1);
    if (last === undefined) return;
    const settledAt = last.finished_at ?? last.started_at;
    const earliest = settledAt + minDelayMs;
    const delay = earliest - now();
    if (delay > 0) await sleep(delay);
  }

  function record(
    intent: IntentRow,
    outcome: ReconOutcome,
    pages: number,
    exhausted: boolean,
    matched: string | null,
  ): void {
    store.recon.record({
      merchant_id: intent.merchant_id,
      sik: intent.sik,
      attempt_seq: Math.max(intent.attempt_seq, 1),
      outcome,
      pages_scanned: pages,
      pagination_exhausted: exhausted,
      matched_entity_id: matched,
      queried_at: now(),
      detail: { reconcile_attempts: intent.reconcile_attempts },
    });
  }

  return {
    async reconcile(intent) {
      const current = store.intents.require(intent.merchant_id, intent.sik);
      if (TERMINAL.has(current.state)) return { kind: 'SETTLED', intent: current };

      // Resume a pass this or another process died in the middle of.
      const reconciling =
        current.state === 'RECONCILING'
          ? current
          : store.intents.transition({
              merchant_id: current.merchant_id,
              sik: current.sik,
              from: 'UNKNOWN',
              to: nextState('UNKNOWN', 'RECONCILE_STARTED'),
              at: now(),
              lease: { owner, expires_at: now() + leaseMs },
              audit_kind: 'RECONCILE_STARTED',
              audit_payload: { attempt_seq: current.attempt_seq },
            });

      await waitForReadYourWrites(reconciling);

      const scan = await scanForSik(rail, reconciling.subject_id, reconciling.sik);

      if (scan.status === 'FOUND') {
        record(reconciling, 'APPLIED', scan.pages, false, scan.refund.id);
        const applied = store.intents.transition({
          merchant_id: reconciling.merchant_id,
          sik: reconciling.sik,
          from: 'RECONCILING',
          to: nextState('RECONCILING', 'RECONCILE_FOUND_APPLIED'),
          at: now(),
          rail_entity_id: scan.refund.id,
          lease: null,
          audit_kind: 'RECONCILE_FOUND_APPLIED',
          audit_payload: { rail_entity_id: scan.refund.id, pages_scanned: scan.pages },
        });
        return { kind: 'APPLIED', intent: applied, rail_entity_id: scan.refund.id };
      }

      if (scan.status === 'EXHAUSTED_NO_MATCH') {
        // The rail was walked end to end in this pass and our stamp is not
        // there. This is the only path to a state a retry may leave from.
        record(reconciling, 'CONFIRMED_NOT_APPLIED', scan.pages, true, null);
        const absent = store.intents.transition({
          merchant_id: reconciling.merchant_id,
          sik: reconciling.sik,
          from: 'RECONCILING',
          to: nextState('RECONCILING', 'RECONCILE_CONFIRMED_ABSENT'),
          at: now(),
          lease: null,
          audit_kind: 'RECONCILE_CONFIRMED_ABSENT',
          audit_payload: { pages_scanned: scan.pages, pagination_exhausted: true },
        });
        return { kind: 'CONFIRMED_NOT_APPLIED', intent: absent };
      }

      // INCOMPLETE. We ran out of rail before we ran out of pages, so we know
      // nothing. Recorded as STILL_UNKNOWN, which the store's CHECK constraint
      // would insist on anyway.
      const attempts = reconciling.reconcile_attempts + 1;
      record(reconciling, 'STILL_UNKNOWN', scan.pages, false, null);

      if (attempts >= maxAttempts) {
        const quarantined = store.intents.transition({
          merchant_id: reconciling.merchant_id,
          sik: reconciling.sik,
          from: 'RECONCILING',
          to: nextState('RECONCILING', 'QUARANTINE'),
          at: now(),
          reconcile_attempts: attempts,
          lease: null,
          audit_kind: 'QUARANTINE',
          audit_payload: { attempts, reason: 'RECONCILE_EXHAUSTED' },
        });
        return { kind: 'QUARANTINED', intent: quarantined, attempts };
      }

      const back = store.intents.transition({
        merchant_id: reconciling.merchant_id,
        sik: reconciling.sik,
        from: 'RECONCILING',
        to: nextState('RECONCILING', 'RECONCILE_INCONCLUSIVE'),
        at: now(),
        reconcile_attempts: attempts,
        lease: null,
        audit_kind: 'RECONCILE_INCONCLUSIVE',
        audit_payload: { attempts, pages_scanned: scan.pages },
      });
      return {
        kind: 'STILL_UNKNOWN',
        intent: back,
        attempts,
        retry_after_ms: backoffMs(attempts, capSeconds),
      };
    },

    async settle(intent) {
      let current = intent;
      for (;;) {
        const outcome = await this.reconcile(current);
        if (outcome.kind !== 'STILL_UNKNOWN') return outcome;
        await sleep(outcome.retry_after_ms);
        current = outcome.intent;
      }
    },
  };
}
