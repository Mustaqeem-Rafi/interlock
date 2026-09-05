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
}

const DECISION_COLUMNS = `request_id, merchant_id, sik, mandate_hash, verdict,
  results_json, decided_at, audit_seq`;

export interface DecisionRepository {
  /** Records the ladder's output and the audit record it produced, atomically. */
  record(merchantId: string, decision: Decision): DecisionRow;
  find(requestId: string): DecisionRow | undefined;
  forIntent(merchantId: string, sik: string): DecisionRow[];
}

export function createDecisionRepository(db: Db): DecisionRepository {
  const insert = db.prepare(
    `INSERT INTO decisions (${DECISION_COLUMNS})
     VALUES (@request_id, @merchant_id, @sik, @mandate_hash, @verdict,
             @results_json, @decided_at, @audit_seq)`,
  );
  const selectOne = db.prepare(`SELECT ${DECISION_COLUMNS} FROM decisions WHERE request_id = ?`);
  const selectForIntent = db.prepare(
    `SELECT ${DECISION_COLUMNS} FROM decisions
     WHERE merchant_id = ? AND sik = ? ORDER BY decided_at ASC`,
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
  };
}
