import type { Mandate } from '@interlock/core';
import type { Store } from '@interlock/store';

/**
 * The shapes the operator console is written against.
 *
 * The console was designed and built against a stated contract; this file
 * serves that contract from the ledger rather than asking the console to be
 * rewritten around whatever the store happened to expose. Where the ledger
 * genuinely does not hold something the console asks for, the honest answer is
 * an empty list or a zero — never a plausible-looking number, because the
 * whole point of this surface is that an operator can trust what it says.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

export interface ConsoleContext {
  readonly store: Store;
  readonly mandate: Mandate;
  readonly railKind: string;
  readonly startedAt: number;
  readonly now: () => number;
}

/** `reason_code` + `message` on the way in, `reasons: [{code, message}]` on the way out. */
function toGateResults(json: string): unknown[] {
  try {
    const parsed = JSON.parse(json) as {
      gate?: string;
      verdict?: string;
      reason_code?: string;
      message?: string;
      evidence?: unknown;
    }[];
    return parsed.map((r) => ({
      gate: r.gate ?? '?',
      // g5 is the only gate that would consult a model, and it is not
      // implemented. Deriving the label from the gate name keeps that true
      // here rather than hard-coding "deterministic" everywhere and having it
      // quietly become a lie if the purpose gate ever lands.
      kind: r.gate === 'g5_purpose' ? 'model' : 'deterministic',
      verdict: r.verdict ?? '?',
      reasons:
        r.reason_code === undefined || r.reason_code === ''
          ? []
          : [{ code: r.reason_code, message: r.message ?? '' }],
      evidence: r.evidence ?? {},
    }));
  } catch {
    return [
      {
        gate: 'unreadable',
        kind: 'deterministic',
        verdict: '?',
        reasons: [{ code: 'RESULTS_JSON_CORRUPT', message: 'this row could not be parsed' }],
        evidence: {},
      },
    ];
  }
}

function decisionSummary(verdict: string, results: unknown[]): string {
  const failing = (results as { verdict: string; reasons: { message: string }[] }[]).find(
    (r) => r.verdict !== 'ALLOW',
  );
  if (failing?.reasons[0]?.message) return failing.reasons[0].message;
  return verdict === 'ALLOW' ? 'Every gate allowed this.' : 'Refused.';
}

interface DecisionShape {
  decision_id: string;
  action_id: string;
  sik: string | null;
  agent_id: string;
  tool: string;
  verdict: string;
  amount_minor: number;
  rupees_at_risk_minor: number;
  mandate_hash: string;
  total_latency_ms: number;
  created_at: number;
  summary: string;
  gate_results: unknown[];
}

function toDecisionShape(row: {
  request_id: string;
  sik: string;
  agent_id: string;
  tool: string;
  verdict: string;
  amount_minor: number;
  mandate_hash: string;
  latency_ms: number;
  decided_at: number;
  results_json: string;
}): DecisionShape {
  const gates = toGateResults(row.results_json);
  return {
    decision_id: row.request_id,
    action_id: row.request_id,
    sik: row.sik === '' ? null : row.sik,
    agent_id: row.agent_id,
    tool: row.tool,
    verdict: row.verdict,
    amount_minor: row.amount_minor,
    // What did not leave because this was refused. An allowed call put nothing
    // at risk — it simply spent — so counting its amount here would inflate
    // "prevented" with money that was always going to move.
    rupees_at_risk_minor: row.verdict === 'ALLOW' ? 0 : row.amount_minor,
    mandate_hash: row.mandate_hash,
    total_latency_ms: row.latency_ms,
    created_at: row.decided_at,
    summary: decisionSummary(row.verdict, gates),
    gate_results: gates,
  };
}

export function health(ctx: ConsoleContext, ready: { ready: boolean; outstanding: number }): {
  status: string;
  version: string;
  recovery: { complete: boolean; stranded_resolved: number };
  rail: string;
  started_at: number;
} {
  return {
    status: ready.ready ? 'ok' : 'recovering',
    version: '0.1.1',
    recovery: { complete: ready.ready, stranded_resolved: ready.outstanding },
    rail: ctx.railKind,
    started_at: ctx.startedAt,
  };
}

export function summary(ctx: ConsoleContext): Record<string, unknown> {
  const since = ctx.now() - DAY_MS;
  const window = ctx.store.decisions.recent({ limit: 500 }).filter((d) => d.decided_at >= since);
  const shaped = window.map(toDecisionShape);
  const by = (v: string): number => shaped.filter((d) => d.verdict === v).length;

  const latencies = shaped.map((d) => d.total_latency_ms).sort((a, b) => a - b);
  const percentile = (p: number): number =>
    latencies.length === 0
      ? 0
      : (latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * p))] ?? 0);

  const counts: Record<string, number> = {};
  for (const row of ctx.store.intents.list({ limit: 5000 })) {
    counts[row.state] = (counts[row.state] ?? 0) + 1;
  }

  const findings = listFindings(ctx);
  return {
    window: '24h',
    rupees_prevented_minor: shaped.reduce((sum, d) => sum + d.rupees_at_risk_minor, 0),
    rupees_allowed_minor: shaped
      .filter((d) => d.verdict === 'ALLOW')
      .reduce((sum, d) => sum + d.amount_minor, 0),
    decisions: { allow: by('ALLOW'), hold: by('HOLD'), block: by('BLOCK'), total: shaped.length },
    /**
     * Duplicates the engine absorbed, counted from the audit log.
     *
     * Not from the gate results: a duplicate passes every gate. It is refused
     * afterwards, by the ledger, because an intent with that key already
     * reached APPLIED. Counting gate verdicts here reported zero on runs that
     * had just prevented a double refund.
     */
    duplicates_prevented: ctx.store.audit
      .read(0, 5000)
      .filter((r) => r.kind === 'DUPLICATE_ABSORBED' && r.ts >= since).length,
    // Always 0: see FINDING_KIND. Nothing scans for orphans at runtime, and a
    // zero that means "nobody looked" is reported rather than dressed up.
    orphans_detected: findings.filter((f) => f.kind === 'orphan').length,
    held_open: counts['HELD'] ?? 0,
    quarantined_open: counts['QUARANTINED'] ?? 0,
    latency_p50_ms: percentile(0.5),
    latency_p99_ms: percentile(0.99),
  };
}

export function decisions(
  ctx: ConsoleContext,
  query: { verdict?: string; agent_id?: string; tool?: string; limit?: number; cursor?: number },
): Record<string, unknown> {
  const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);
  // Read a page wider than asked for, filter, then slice. The filters are not
  // all indexed, and a narrow read plus a filter can return an empty page
  // while rows that match sit just past the end of it.
  const rows = ctx.store.decisions
    .recent({ limit: 500 })
    .map(toDecisionShape)
    .filter(
      (d) =>
        (query.verdict === undefined || d.verdict === query.verdict) &&
        (query.agent_id === undefined || d.agent_id === query.agent_id) &&
        (query.tool === undefined || d.tool === query.tool),
    );
  const cursor = query.cursor ?? 0;
  const page = rows.slice(cursor, cursor + limit);
  return {
    // The list omits gate_results; the detail route carries them.
    items: page.map(({ gate_results: _gates, ...rest }) => rest),
    next_cursor: cursor + limit < rows.length ? String(cursor + limit) : null,
    total: rows.length,
  };
}

export function decision(ctx: ConsoleContext, id: string): DecisionShape | undefined {
  const row = ctx.store.decisions.find(id);
  return row === undefined ? undefined : toDecisionShape(row);
}

export function intent(ctx: ConsoleContext, sik: string): Record<string, unknown> | undefined {
  const row = ctx.store.intents.find(ctx.mandate.merchant_id, sik);
  if (row === undefined) return undefined;

  const attempts = ctx.store.intents.attempts(ctx.mandate.merchant_id, sik);
  const decisionsForIntent = ctx.store.decisions.forIntent(ctx.mandate.merchant_id, sik);

  /**
   * The transition list comes from the audit log, not from a field.
   *
   * I6 says every state change appends exactly one record, so the log already
   * is the history. Keeping a second copy on the intent would create two
   * accounts of the same events that can disagree, and the one on the intent
   * would be the one without a hash chain behind it.
   */
  const transitions = ctx.store.audit
    .read(0, 2000)
    .filter((record) => {
      const payload = record.payload as { sik?: string } | null;
      return payload?.sik === sik;
    })
    .map((record) => {
      const payload = record.payload as {
        from?: string;
        to?: string;
        event?: string;
        reason?: string;
        operator?: string;
      };
      return {
        at: record.ts,
        from: payload.from ?? null,
        to: payload.to ?? null,
        event: payload.event ?? record.kind,
        note:
          payload.reason === undefined
            ? record.kind
            : `${payload.reason}${payload.operator === undefined ? '' : ` — ${payload.operator}`}`,
      };
    });

  return {
    sik: row.sik,
    merchant_id: row.merchant_id,
    agent_id: decisionsForIntent[0]?.agent_id ?? ctx.mandate.agent_id,
    tool: row.tool,
    subject_id: row.subject_id,
    amount_minor: row.amount_minor,
    currency: row.currency,
    reversibility: row.reversibility,
    state: row.state,
    rail_entity_id: row.rail_entity_id,
    mandate_hash: row.mandate_hash,
    first_seen_at: row.first_seen_at,
    updated_at: row.updated_at,
    transitions,
    attempts: attempts.map((a) => ({
      attempt_seq: a.attempt_seq,
      started_at: a.started_at,
      finished_at: a.finished_at,
      outcome: a.outcome,
      http_status: a.http_status,
      rail_error_code: a.error_code,
    })),
  };
}

interface Finding {
  kind: string;
  agent_id: string;
  sik: string;
  detail: string;
  at: number;
}

/**
 * What the reconciler actually records, mapped to what the console asks for.
 *
 * The console has a slot for orphans — rail entities with no ledger row. We do
 * not detect those at runtime and this does not pretend to: finding an orphan
 * means walking the rail's whole history against the ledger, which is a
 * benchmark-time sweep, not something the reconciler does per intent. The
 * number the README quotes for orphan rate comes from there and says so.
 *
 * So orphans_detected is 0 here, and it is 0 because nothing looked — not
 * because nothing was found. Those are different claims and the second one
 * would be a lie.
 */
const FINDING_KIND: Readonly<Record<string, string>> = {
  APPLIED: 'reconciled_applied',
  CONFIRMED_NOT_APPLIED: 'reconciled_absent',
  STILL_UNKNOWN: 'unresolved',
};

export function listFindings(ctx: ConsoleContext, kind?: string): Finding[] {
  const found: Finding[] = [];
  for (const row of ctx.store.intents.list({ limit: 1000 })) {
    for (const finding of ctx.store.recon.forIntent(row.merchant_id, row.sik)) {
      const asKind = FINDING_KIND[finding.outcome] ?? String(finding.outcome).toLowerCase();
      if (kind !== undefined && asKind !== kind) continue;
      found.push({
        kind: asKind,
        agent_id: ctx.mandate.agent_id,
        sik: row.sik,
        detail: `${row.tool} on ${row.subject_id}`,
        at: finding.queried_at,
      });
    }
  }
  return found;
}

export function agents(ctx: ConsoleContext): Record<string, unknown> {
  /**
   * v0.1 runs one mandate for one agent, so this list has one entry.
   *
   * It is still a list, because that is the contract and because the shape is
   * what changes when a second mandate is supported — not the console.
   */
  const all = ctx.store.decisions.recent({ limit: 500 }).map(toDecisionShape);
  const counts: Record<string, number> = {};
  for (const row of ctx.store.intents.list({ limit: 5000 })) {
    counts[row.state] = (counts[row.state] ?? 0) + 1;
  }
  const mine = all.filter((d) => d.agent_id === ctx.mandate.agent_id);
  return {
    items: [
      {
        agent_id: ctx.mandate.agent_id,
        label: ctx.mandate.agent_id,
        mandate_id: ctx.mandate.mandate_id,
        mandate_hash: ctx.mandate.provenance.manifest_sha256,
        actions_total: mine.length,
        rupees_prevented_minor: mine.reduce((sum, d) => sum + d.rupees_at_risk_minor, 0),
        rupees_allowed_minor: mine
          .filter((d) => d.verdict === 'ALLOW')
          .reduce((sum, d) => sum + d.amount_minor, 0),
        held_open: counts['HELD'] ?? 0,
        orphans: listFindings(ctx, 'orphan').length,
      },
    ],
  };
}

export function mandates(ctx: ConsoleContext): Record<string, unknown> {
  return {
    items: [
      {
        mandate_id: ctx.mandate.mandate_id,
        agent_id: ctx.mandate.agent_id,
        version: 1,
        mandate_hash: ctx.mandate.provenance.manifest_sha256,
        granted_tools: Object.keys(ctx.mandate.scope.grants),
        expires_at: new Date(ctx.mandate.expires_at).toISOString(),
      },
    ],
  };
}

export function auditVerify(ctx: ConsoleContext): Record<string, unknown> {
  const firstBroken = ctx.store.audit.verifyChain();
  const head = ctx.store.audit.head();
  return {
    ok: firstBroken === null,
    checked: ctx.store.audit.count(),
    first_divergent_seq: firstBroken,
    head_hash: head === undefined ? null : `sha256:${head.hash}`,
  };
}
