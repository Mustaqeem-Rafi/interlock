import {
  AUDIT_GENESIS_HASH,
  nextChainRow,
  verifyChainOver,
  type ChainRow,
} from './chain.js';
import { inWriteTransaction, type Db } from './db.js';

/**
 * The audit log is a hash chain, so a row cannot be altered or removed after the
 * fact without the chain saying where. I6: every state change appends exactly
 * one record, and seq is gapless.
 *
 * The chain arithmetic itself lives in chain.ts; this file is only its storage.
 */

export interface AuditRecord {
  readonly seq: number;
  readonly ts: number;
  readonly kind: string;
  readonly payload: unknown;
  readonly prev_hash: string;
  readonly hash: string;
}

export interface AppendAuditInput {
  readonly kind: string;
  readonly payload: unknown;
  readonly ts: number;
}

const AUDIT_COLUMNS = 'seq, ts, kind, payload_json, prev_hash, hash';

/**
 * Append one record. Must be called inside a write transaction — reading the
 * head and inserting its successor is one atomic step, and callers that also
 * mutate an intent need the whole thing to commit or roll back together.
 */
export function appendAuditWithin(db: Db, input: AppendAuditInput): AuditRecord {
  const head = db.prepare('SELECT seq, hash FROM audit_log ORDER BY seq DESC LIMIT 1').get() as
    | Pick<ChainRow, 'seq' | 'hash'>
    | undefined;

  const row = nextChainRow(head, input.ts, input.kind, input.payload);

  db.prepare(
    `INSERT INTO audit_log (${AUDIT_COLUMNS})
     VALUES (@seq, @ts, @kind, @payload_json, @prev_hash, @hash)`,
  ).run(row);

  return {
    seq: row.seq,
    ts: row.ts,
    kind: row.kind,
    payload: input.payload,
    prev_hash: row.prev_hash,
    hash: row.hash,
  };
}

function toRecord(row: ChainRow): AuditRecord {
  return {
    seq: row.seq,
    ts: row.ts,
    kind: row.kind,
    payload: JSON.parse(row.payload_json),
    prev_hash: row.prev_hash,
    hash: row.hash,
  };
}

export interface AuditRepository {
  /** Append one record in its own transaction. */
  append(input: AppendAuditInput): AuditRecord;
  read(fromSeq?: number, limit?: number): AuditRecord[];
  head(): AuditRecord | undefined;
  count(): number;
  /**
   * Walk the chain from genesis. Returns the seq of the first record that does
   * not verify, or null if the whole chain holds.
   */
  verifyChain(): number | null;
}

export function createAuditRepository(db: Db): AuditRepository {
  const selectAll = db.prepare(`SELECT ${AUDIT_COLUMNS} FROM audit_log ORDER BY seq ASC`);
  const selectFrom = db.prepare(
    `SELECT ${AUDIT_COLUMNS} FROM audit_log WHERE seq >= ? ORDER BY seq ASC LIMIT ?`,
  );
  const selectHead = db.prepare(
    `SELECT ${AUDIT_COLUMNS} FROM audit_log ORDER BY seq DESC LIMIT 1`,
  );
  const selectCount = db.prepare('SELECT COUNT(*) AS n FROM audit_log');

  return {
    append(input) {
      return inWriteTransaction(db, () => appendAuditWithin(db, input));
    },

    read(fromSeq = 1, limit = 1000) {
      return (selectFrom.all(fromSeq, limit) as ChainRow[]).map(toRecord);
    },

    head() {
      const row = selectHead.get() as ChainRow | undefined;
      return row === undefined ? undefined : toRecord(row);
    },

    count() {
      return (selectCount.get() as { n: number }).n;
    },

    verifyChain() {
      return verifyChainOver(selectAll.iterate() as IterableIterator<ChainRow>);
    },
  };
}

export { AUDIT_GENESIS_HASH };
