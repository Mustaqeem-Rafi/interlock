import type { Store } from '@interlock/store';
import type { IntentState } from '@interlock/core';

/**
 * Read models for the operator console.
 *
 * Everything here is derived from the ledger. Nothing is computed and stored:
 * a console that keeps its own counters is a second source of truth, and the
 * first question an operator asks during an incident is which one to believe.
 */

/** States a human is expected to act on, in the order they should be looked at. */
export const NEEDS_A_HUMAN: readonly IntentState[] = ['QUARANTINED', 'HELD'];

/** Everything the engine may still resolve on its own. */
const IN_PROGRESS: readonly IntentState[] = [
  'PROPOSED',
  'AUTHORIZED',
  'IN_FLIGHT',
  'UNKNOWN',
  'RECONCILING',
  'CONFIRMED_NOT_APPLIED',
];

export interface Summary {
  readonly counts: Readonly<Record<string, number>>;
  readonly needs_attention: number;
  readonly in_progress: number;
  readonly applied_24h: {
    readonly calls: number;
    readonly amount_minor: number;
    readonly fee_minor: number;
  };
  readonly audit: { readonly records: number; readonly head_hash: string | null };
}

export function summarise(store: Store, merchantId: string, now: number): Summary {
  const counts: Record<string, number> = {};
  for (const row of store.intents.list({ limit: 5000 })) {
    counts[row.state] = (counts[row.state] ?? 0) + 1;
  }

  // Only APPLIED intents have spent anything, which is the same rule Gate 3
  // uses. Reporting attempts here and spend there would put two different
  // numbers for "what left" in front of the same operator.
  const day = store.intents.windowTotals({
    merchant_id: merchantId,
    since: now - 24 * 60 * 60 * 1000,
    until: now,
  });

  const head = store.audit.head();
  return {
    counts,
    needs_attention: NEEDS_A_HUMAN.reduce((total, state) => total + (counts[state] ?? 0), 0),
    in_progress: IN_PROGRESS.reduce((total, state) => total + (counts[state] ?? 0), 0),
    applied_24h: {
      calls: day.calls,
      amount_minor: day.amount_minor,
      fee_minor: day.fee_minor,
    },
    audit: { records: store.audit.count(), head_hash: head?.hash ?? null },
  };
}

export interface IntentView {
  readonly sik: string;
  readonly tool: string;
  readonly subject_id: string;
  readonly amount_minor: number;
  readonly currency: string;
  readonly state: string;
  readonly attempt_seq: number;
  readonly rail_entity_id: string | null;
  readonly first_seen_at: number;
  readonly updated_at: number;
  /** Why it is where it is: the latest reconciliation finding, when there is one. */
  readonly last_finding: string | null;
}

export function listIntents(
  store: Store,
  options: { states?: readonly IntentState[]; limit?: number },
): IntentView[] {
  return store.intents
    .list({
      ...(options.states === undefined ? {} : { states: options.states }),
      limit: Math.min(Math.max(options.limit ?? 100, 1), 500),
    })
    .map((row) => {
      const findings = store.recon.forIntent(row.merchant_id, row.sik);
      const latest = findings[findings.length - 1];
      return {
        sik: row.sik,
        tool: row.tool,
        subject_id: row.subject_id,
        amount_minor: row.amount_minor,
        currency: row.currency,
        state: row.state,
        attempt_seq: row.attempt_seq,
        rail_entity_id: row.rail_entity_id,
        first_seen_at: row.first_seen_at,
        updated_at: row.updated_at,
        last_finding: latest?.outcome ?? null,
      };
    });
}

export interface DecisionView {
  readonly request_id: string;
  readonly sik: string;
  readonly verdict: string;
  readonly decided_at: number;
  readonly gates: readonly { gate: string; verdict: string; reason_code: string }[];
}

export function listDecisions(
  store: Store,
  options: { verdict?: string; limit?: number; before?: number },
): DecisionView[] {
  return store.decisions.recent(options).map((row) => {
    // results_json is written by us and validated on the way in, but this is a
    // parse at a boundary all the same: a corrupt row should degrade one line
    // of the console, not take the whole page down.
    let gates: DecisionView['gates'] = [];
    try {
      const parsed = JSON.parse(row.results_json) as {
        gate?: string;
        verdict?: string;
        reason_code?: string;
      }[];
      gates = parsed.map((g) => ({
        gate: g.gate ?? '?',
        verdict: g.verdict ?? '?',
        reason_code: g.reason_code ?? '',
      }));
    } catch {
      gates = [{ gate: 'unreadable', verdict: '?', reason_code: 'RESULTS_JSON_CORRUPT' }];
    }
    return {
      request_id: row.request_id,
      sik: row.sik,
      verdict: row.verdict,
      decided_at: row.decided_at,
      gates,
    };
  });
}

/**
 * Is this ledger settled enough to serve from?
 *
 * The proxy answers readiness from the recovery pass it actually runs. The
 * console cannot: it is a reader beside a writer, it must not reclaim leases
 * the proxy is reclaiming, and asking its own idle Recovery object gives the
 * answer "still scanning" forever — a health endpoint that never goes green.
 *
 * So it asks the shared state instead. An intent holding a lapsed lease means
 * some process died mid-refund and boot recovery has not finished settling it.
 * Serving decisions from a ledger in that condition is exactly what the 503 is
 * for, and it becomes true again on its own once the proxy has recovered.
 */
export function ledgerReadiness(
  store: Store,
  now: number,
): { ready: boolean; phase: string; outstanding: number; status: 200 | 503 } {
  const stranded = store.intents.sweepExpiredLeases(now, {
    states: ['IN_FLIGHT', 'RECONCILING'],
    limit: 100,
  });
  return stranded.length === 0
    ? { ready: true, phase: 'ready', outstanding: 0, status: 200 }
    : { ready: false, phase: 'unrecovered', outstanding: stranded.length, status: 503 };
}
