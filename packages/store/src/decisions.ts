import type { Decision } from '@interlock/core';
import { appendAuditWithin } from './audit.js';
import { inWriteTransaction, type Db } from './db.js';

export interface DecisionRow {
  readonly request_id: string;
  readonly merchant_id: string;
  readonly sik: string;
  readonly mandate_hash: string;
  readonly verdict: string;
  readonly results_json: string;
  readonly decided_at: number;
  readonly audit_seq: number;
  readonly agent_id: string;
  readonly tool: string;
  readonly amount_minor: number;
  readonly latency_ms: number;
}

const DECISION_COLUMNS = `request_id, merchant_id, sik, mandate_hash, verdict,
  results_json, decided_at, audit_seq, agent_id, tool, amount_minor, latency_ms`;

export interface DecisionRepository {
  /** Records the ladder's output and the audit record it produced, atomically. */
  record(merchantId: string, decision: Decision): DecisionRow;
  find(requestId: string): DecisionRow | undefined;
  forIntent(merchantId: string, sik: string): DecisionRow[];
  /**
   * Newest first, for the operator console.
   *
   * `before` is the decided_at of the last row already shown, so paging is a
   * keyset walk rather than an OFFSET: the console polls, decisions keep
   * arriving, and OFFSET would silently repeat or skip rows as the table grows
   * underneath it.
   */
  recent(options?: { verdict?: string; limit?: number; before?: number }): DecisionRow[];
}

export function createDecisionRepository(db: Db): DecisionRepository {
  const insert = db.prepare(
    `INSERT INTO decisions (${DECISION_COLUMNS})
     VALUES (@request_id, @merchant_id, @sik, @mandate_hash, @verdict,
             @results_json, @decided_at, @audit_seq, @agent_id, @tool,
             @amount_minor, @latency_ms)`,
  );
  const selectOne = db.prepare(`SELECT ${DECISION_COLUMNS} FROM decisions WHERE request_id = ?`);
  const selectForIntent = db.prepare(
    `SELECT ${DECISION_COLUMNS} FROM decisions
     WHERE merchant_id = ? AND sik = ? ORDER BY decided_at ASC`,
  );

  const selectRecent = db.prepare(
    `SELECT ${DECISION_COLUMNS} FROM decisions
     WHERE decided_at < @before AND (@verdict IS NULL OR verdict = @verdict)
     ORDER BY decided_at DESC, request_id DESC LIMIT @limit`,
  );

  return {
    record(merchantId, decision) {
      return inWriteTransaction(db, () => {
        const audit = appendAuditWithin(db, {
          kind: 'DECISION_RECORDED',
          ts: decision.decided_at,
          payload: {
            merchant_id: merchantId,
            request_id: decision.request_id,
            sik: decision.sik,
            mandate_hash: decision.mandate_hash,
            verdict: decision.verdict,
            gates: decision.results.map((result) => ({
              gate: result.gate,
              verdict: result.verdict,
              reason_code: result.reason_code,
            })),
          },
        });

        insert.run({
          request_id: decision.request_id,
          merchant_id: merchantId,
          sik: decision.sik,
          mandate_hash: decision.mandate_hash,
          verdict: decision.verdict,
          results_json: JSON.stringify(decision.results),
          decided_at: decision.decided_at,
          audit_seq: audit.seq,
          agent_id: decision.agent_id,
          tool: decision.tool,
          amount_minor: decision.amount_minor,
          latency_ms: decision.latency_ms,
        });

        return selectOne.get(decision.request_id) as DecisionRow;
      });
    },

    find(requestId) {
      return selectOne.get(requestId) as DecisionRow | undefined;
    },

    forIntent(merchantId, sik) {
      return selectForIntent.all(merchantId, sik) as DecisionRow[];
    },

    recent(options = {}) {
      return selectRecent.all({
        verdict: options.verdict ?? null,
        limit: Math.min(Math.max(options.limit ?? 50, 1), 500),
        before: options.before ?? Number.MAX_SAFE_INTEGER,
      }) as DecisionRow[];
    },
  };
}
