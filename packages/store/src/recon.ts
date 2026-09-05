import { InvariantViolation, type ReconOutcome } from '@interlock/core';
import { appendAuditWithin } from './audit.js';
import { inWriteTransaction, type Db } from './db.js';

export interface ReconFindingRow {
  readonly id: number;
  readonly merchant_id: string;
  readonly sik: string;
  readonly attempt_seq: number;
  readonly outcome: ReconOutcome;
  readonly pages_scanned: number;
  /** SQLite has no boolean; 0 or 1. */
  readonly pagination_exhausted: number;
  readonly matched_entity_id: string | null;
  readonly queried_at: number;
  readonly detail_json: string;
}

export interface NewReconFinding {
  readonly merchant_id: string;
  readonly sik: string;
  readonly attempt_seq: number;
  readonly outcome: ReconOutcome;
  readonly pages_scanned: number;
  /** True only if this pass read every page, not just the first. */
  readonly pagination_exhausted: boolean;
  readonly matched_entity_id?: string | null;
  readonly queried_at: number;
  readonly detail?: unknown;
}

const RECON_COLUMNS = `id, merchant_id, sik, attempt_seq, outcome, pages_scanned,
  pagination_exhausted, matched_entity_id, queried_at, detail_json`;

export interface ReconRepository {
  record(finding: NewReconFinding): ReconFindingRow;
  forIntent(merchantId: string, sik: string): ReconFindingRow[];
  latestForAttempt(
    merchantId: string,
    sik: string,
    attemptSeq: number,
  ): ReconFindingRow | undefined;
}

export function createReconRepository(db: Db): ReconRepository {
  const insert = db.prepare(
    `INSERT INTO recon_findings
       (merchant_id, sik, attempt_seq, outcome, pages_scanned, pagination_exhausted,
        matched_entity_id, queried_at, detail_json)
     VALUES (@merchant_id, @sik, @attempt_seq, @outcome, @pages_scanned, @pagination_exhausted,
             @matched_entity_id, @queried_at, @detail_json)`,
  );
  const selectById = db.prepare(`SELECT ${RECON_COLUMNS} FROM recon_findings WHERE id = ?`);
  const selectForIntent = db.prepare(
    `SELECT ${RECON_COLUMNS} FROM recon_findings
     WHERE merchant_id = ? AND sik = ? ORDER BY id ASC`,
  );
  const selectLatest = db.prepare(
    `SELECT ${RECON_COLUMNS} FROM recon_findings
     WHERE merchant_id = ? AND sik = ? AND attempt_seq = ? ORDER BY id DESC LIMIT 1`,
  );

  return {
    record(finding) {
      // Trap 1, stated twice on purpose: once here so the error names the rule,
      // and once as a CHECK constraint so no other writer can get around it.
      // Absence on page one is not absence.
      if (finding.outcome === 'CONFIRMED_NOT_APPLIED' && !finding.pagination_exhausted) {
        throw new InvariantViolation(
          'recon.pagination',
          'CONFIRMED_NOT_APPLIED requires pagination to have run to exhaustion in this pass; ' +
            'record STILL_UNKNOWN instead',
        );
      }

      return inWriteTransaction(db, () => {
        const result = insert.run({
          merchant_id: finding.merchant_id,
          sik: finding.sik,
          attempt_seq: finding.attempt_seq,
          outcome: finding.outcome,
          pages_scanned: finding.pages_scanned,
          pagination_exhausted: finding.pagination_exhausted ? 1 : 0,
          matched_entity_id: finding.matched_entity_id ?? null,
          queried_at: finding.queried_at,
          detail_json: JSON.stringify(finding.detail ?? {}),
        });

        appendAuditWithin(db, {
          kind: 'RECON_FINDING',
          ts: finding.queried_at,
          payload: {
            merchant_id: finding.merchant_id,
            sik: finding.sik,
            attempt_seq: finding.attempt_seq,
            outcome: finding.outcome,
            pages_scanned: finding.pages_scanned,
            pagination_exhausted: finding.pagination_exhausted,
            matched_entity_id: finding.matched_entity_id ?? null,
          },
        });

        return selectById.get(Number(result.lastInsertRowid)) as ReconFindingRow;
      });
    },

    forIntent(merchantId, sik) {
      return selectForIntent.all(merchantId, sik) as ReconFindingRow[];
    },

    latestForAttempt(merchantId, sik, attemptSeq) {
      return selectLatest.get(merchantId, sik, attemptSeq) as ReconFindingRow | undefined;
    },
  };
}
