import type { IntentRow, Store } from '@interlock/store';
import { nextState } from './machine.js';
import type { Reconciler, ReconcileOutcome } from './reconciler.js';

/**
 * Boot recovery.
 *
 * A process that dies mid-attempt leaves an IN_FLIGHT row with a lease nobody
 * will ever renew, and a process that dies mid-pass leaves a RECONCILING one.
 * Both mean the same thing: a rail call may have applied and nothing is going
 * to find out unless we do.
 *
 * So recovery runs before any traffic is served, not alongside it. Serving a
 * request while an unaccounted IN_FLIGHT row exists is how the same refund goes
 * out twice — the new request proposes, sees no live intent it recognises, and
 * issues. Until every recovered intent has been reconciled, /health answers 503
 * and says how many are still outstanding.
 */

export const RECOVERY_REASON = 'RECOVERED_AFTER_RESTART';

/**
 * States a dead process can leave behind.
 *
 * UNKNOWN is here because the chaos matrix found it missing. A rail call that
 * ends ambiguously records UNKNOWN and hands the intent to whoever reconciles
 * next — but nothing did. The periodic sweep only detects drift, boot recovery
 * only looked at IN_FLIGHT and RECONCILING, and so an intent that reached
 * UNKNOWN cleanly sat there forever with money possibly gone and nothing ever
 * going to check. A restart now heals it, which also covers a crash landing in
 * the window between recording UNKNOWN and reconciling it.
 */
const RECOVERABLE = ['IN_FLIGHT', 'RECONCILING', 'UNKNOWN'] as const;

export type RecoveryPhase = 'scanning' | 'reconciling' | 'ready';

export interface Readiness {
  readonly ready: boolean;
  readonly phase: RecoveryPhase;
  /** Recovered intents not yet reconciled. Reported in the 503 body. */
  readonly outstanding: number;
  readonly status: 200 | 503;
}

export interface RecoveryReport {
  readonly recovered: number;
  readonly applied: number;
  readonly confirmed_not_applied: number;
  readonly quarantined: number;
  readonly settled: number;
}

export interface Recovery {
  /** What /health should answer right now. */
  readiness(): Readiness;
  /** Move stale leases to UNKNOWN, then reconcile every one of them. */
  run(): Promise<RecoveryReport>;
}

export interface RecoveryOptions {
  readonly store: Store;
  readonly reconciler: Reconciler;
  readonly now?: () => number;
  readonly limit?: number;
  /**
   * Which stale rows to reclaim.
   *
   * `all` is the default and the right answer on boot: v0.1 is single-node, so
   * if we are starting up then nothing else is holding a lease, and a lease
   * with time left on it belongs to the process that just died. Waiting for it
   * to expire would leave an IN_FLIGHT row unaccounted for while /health
   * reported ready — which is exactly the window a restart is supposed to close.
   *
   * `expired` is for the periodic in-process sweep, where other work genuinely
   * may hold a live lease.
   */
  readonly reclaim?: 'all' | 'expired';
}

export function createRecovery(options: RecoveryOptions): Recovery {
  const { store, reconciler } = options;
  const now = options.now ?? ((): number => Date.now());
  const limit = options.limit ?? 1000;
  const reclaim = options.reclaim ?? 'all';

  let phase: RecoveryPhase = 'scanning';
  let outstanding = 0;

  /**
   * Both recoverable states have an edge to UNKNOWN in the machine, and they
   * are different edges because they mean different things: an IN_FLIGHT row
   * lost its lease, a RECONCILING row lost its pass.
   */
  function toUnknown(intent: IntentRow): IntentRow {
    const event = intent.state === 'IN_FLIGHT' ? 'LEASE_EXPIRED' : 'RECONCILE_INCONCLUSIVE';
    return store.intents.transition({
      merchant_id: intent.merchant_id,
      sik: intent.sik,
      from: intent.state,
      to: nextState(intent.state, event),
      at: now(),
      lease: null,
      audit_kind: RECOVERY_REASON,
      audit_payload: {
        reason: RECOVERY_REASON,
        from: intent.state,
        via: event,
        attempt_seq: intent.attempt_seq,
        stale_lease_owner: intent.lease_owner,
        stale_lease_expires_at: intent.lease_expires_at,
      },
    });
  }

  return {
    readiness() {
      const ready = phase === 'ready';
      return {
        ready,
        phase,
        outstanding,
        status: ready ? 200 : 503,
      };
    },

    async run() {
      phase = 'scanning';
      const stale =
        reclaim === 'all'
          ? store.intents.list({ states: RECOVERABLE, limit })
          : store.intents.sweepExpiredLeases(now(), { states: RECOVERABLE, limit });

      // Already UNKNOWN: nothing to move, it just needs reconciling.
      const recovered = stale.map((intent) =>
        intent.state === 'UNKNOWN' ? intent : toUnknown(intent),
      );
      outstanding = recovered.length;
      phase = 'reconciling';

      const tally = { applied: 0, confirmed_not_applied: 0, quarantined: 0, settled: 0 };
      for (const intent of recovered) {
        const outcome: ReconcileOutcome = await reconciler.settle(intent);
        switch (outcome.kind) {
          case 'APPLIED':
            tally.applied += 1;
            break;
          case 'CONFIRMED_NOT_APPLIED':
            tally.confirmed_not_applied += 1;
            break;
          case 'QUARANTINED':
            tally.quarantined += 1;
            break;
          default:
            tally.settled += 1;
            break;
        }
        outstanding -= 1;
      }

      phase = 'ready';
      return { recovered: recovered.length, ...tally };
    },
  };
}
