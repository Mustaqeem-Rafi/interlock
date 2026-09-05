import type { IntentRow, Store } from '@interlock/store';
import type { Page, Rail, Refund } from '../rail/rail.js';
import { sikOf } from './reconciler.js';

/**
 * The drift sweep.
 *
 * The reconciler answers "what happened to this one intent". This answers a
 * different and less comfortable question: does the ledger still agree with the
 * rail at all? It runs on a timer rather than on a request, because the failures
 * it looks for are the ones nobody is waiting on an answer for.
 *
 * Three classes, in descending order of how much they would ruin your day:
 *
 *   DUPLICATE        two rail entities carrying one sik. This is exactly-once
 *                    having failed. It should be impossible and the sweep exists
 *                    so that if it ever happens we find out in under a minute
 *                    rather than from a customer.
 *   PHANTOM_SUCCESS  an intent we recorded as APPLIED with no rail entity behind
 *                    it. The ledger is claiming money moved when it did not.
 *   ORPHAN           a rail entity inside the window with no intent row at all.
 *                    Money left by a path that did not go through the gate.
 *
 * Trap 1 applies here as it does in the reconciler, but the three classes are
 * not equally exposed to it, and that difference decides what an incomplete
 * walk is allowed to report:
 *
 *   - DUPLICATE is a *presence* claim. Two entities carrying one sik is a fact
 *     about rows we actually read, and no number of unread pages can make it
 *     false. So it is reported even from an incomplete walk. It is the most
 *     severe finding here, and going quiet about it during a rail incident —
 *     precisely when it is most likely to happen — is the wrong direction to
 *     fail in.
 *   - PHANTOM_SUCCESS and ORPHAN are *absence* claims, inferred from rows we
 *     did not read. An incomplete walk cannot support either, so they are
 *     withheld and `complete: false` records that they were never evaluated.
 */

export const SWEEP_INTERVAL_MS = 60_000;

/** How far back to look. A day comfortably covers any reconciliation backlog. */
export const SWEEP_WINDOW_MS = 24 * 60 * 60 * 1_000;

export interface DuplicateFinding {
  readonly kind: 'DUPLICATE';
  readonly sik: string;
  readonly payment_id: string;
  readonly rail_entity_ids: readonly string[];
}

export interface PhantomFinding {
  readonly kind: 'PHANTOM_SUCCESS';
  readonly merchant_id: string;
  readonly sik: string;
  readonly recorded_entity_id: string | null;
}

export interface OrphanFinding {
  readonly kind: 'ORPHAN';
  readonly rail_entity_id: string;
  readonly payment_id: string;
  /** Null when the entity carries no stamp at all — it never saw the gate. */
  readonly sik: string | null;
}

export type SweepFinding = DuplicateFinding | PhantomFinding | OrphanFinding;

export interface SweepReport {
  /** False when the rail walk did not reach the end. No absence claims are made. */
  readonly complete: boolean;
  readonly scanned_entities: number;
  readonly scanned_intents: number;
  readonly pages: number;
  readonly duplicates: readonly DuplicateFinding[];
  readonly phantoms: readonly PhantomFinding[];
  readonly orphans: readonly OrphanFinding[];
}

export interface SweepOptions {
  readonly store: Store;
  readonly rail: Rail;
  readonly now?: () => number;
  readonly windowMs?: number;
  readonly intervalMs?: number;
}

export interface Sweep {
  runOnce(): Promise<SweepReport>;
  /** Start the timer. Returns a function that stops it. */
  start(): () => void;
}

export function createSweep(options: SweepOptions): Sweep {
  const { store, rail } = options;
  const now = options.now ?? ((): number => Date.now());
  const windowMs = options.windowMs ?? SWEEP_WINDOW_MS;
  const intervalMs = options.intervalMs ?? SWEEP_INTERVAL_MS;

  /** Walk every refund in the window, or admit that we could not. */
  async function enumerate(
    sinceMs: number,
  ): Promise<{ refunds: Refund[]; pages: number; complete: boolean }> {
    const refunds: Refund[] = [];
    let cursor: string | null = null;
    let pages = 0;
    try {
      for (;;) {
        const page: Page<Refund> = await rail.listRefunds(sinceMs, cursor);
        pages += 1;
        refunds.push(...page.items);
        cursor = page.next_cursor;
        if (cursor === null) return { refunds, pages, complete: true };
      }
    } catch {
      return { refunds, pages, complete: false };
    }
  }

  function auditFindings(findings: readonly SweepFinding[], at: number): void {
    for (const finding of findings) {
      store.audit.append({
        kind: `SWEEP_${finding.kind}`,
        ts: at,
        payload: { ...finding },
      });
    }
  }

  return {
    async runOnce() {
      const at = now();
      const since = Math.max(0, at - windowMs);

      const { refunds, pages, complete } = await enumerate(since);
      const intents = store.intents.list({ updatedSince: since });

      const entitiesBySik = new Map<string, Refund[]>();
      const unstamped: Refund[] = [];
      for (const refund of refunds) {
        const sik = sikOf(refund);
        if (sik === null) {
          unstamped.push(refund);
          continue;
        }
        const group = entitiesBySik.get(sik) ?? [];
        group.push(refund);
        entitiesBySik.set(sik, group);
      }

      // Computed before the completeness gate on purpose: sound on whatever we
      // managed to read. See the note on presence claims at the top of the file.
      const duplicates: DuplicateFinding[] = [];
      for (const [sik, group] of entitiesBySik) {
        if (group.length > 1) {
          duplicates.push({
            kind: 'DUPLICATE',
            sik,
            payment_id: group[0]!.payment_id,
            rail_entity_ids: group.map((refund) => refund.id),
          });
        }
      }

      if (!complete) {
        // Raise what we know; refuse to guess at what we do not.
        auditFindings(duplicates, at);
        return {
          complete: false,
          scanned_entities: refunds.length,
          scanned_intents: intents.length,
          pages,
          duplicates,
          phantoms: [],
          orphans: [],
        };
      }

      const intentsBySik = new Map<string, IntentRow>();
      for (const intent of intents) intentsBySik.set(intent.sik, intent);

      const orphans: OrphanFinding[] = [
        ...unstamped.map(
          (refund): OrphanFinding => ({
            kind: 'ORPHAN',
            rail_entity_id: refund.id,
            payment_id: refund.payment_id,
            sik: null,
          }),
        ),
        ...[...entitiesBySik.entries()]
          .filter(([sik]) => !intentsBySik.has(sik))
          .flatMap(([sik, group]) =>
            group.map(
              (refund): OrphanFinding => ({
                kind: 'ORPHAN',
                rail_entity_id: refund.id,
                payment_id: refund.payment_id,
                sik,
              }),
            ),
          ),
      ];

      const phantoms: PhantomFinding[] = intents
        .filter(
          (intent) =>
            intent.state === 'APPLIED' &&
            (intent.rail_entity_id === null || !entitiesBySik.has(intent.sik)),
        )
        .map((intent) => ({
          kind: 'PHANTOM_SUCCESS',
          merchant_id: intent.merchant_id,
          sik: intent.sik,
          recorded_entity_id: intent.rail_entity_id,
        }));

      auditFindings([...duplicates, ...phantoms, ...orphans], at);

      return {
        complete: true,
        scanned_entities: refunds.length,
        scanned_intents: intents.length,
        pages,
        duplicates,
        phantoms,
        orphans,
      };
    },

    start() {
      const timer = setInterval(() => {
        void this.runOnce();
      }, intervalMs);
      // Never hold the process open on account of the sweep.
      timer.unref?.();
      return () => {
        clearInterval(timer);
      };
    },
  };
}
