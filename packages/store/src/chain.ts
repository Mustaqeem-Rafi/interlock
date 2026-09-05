import { canonicalJson, sha256Hex } from '@interlock/core';

/**
 * The audit hash chain, with no database in sight.
 *
 * This is the part that has to be right: it is what makes a tampered ledger
 * detectable. Keeping it pure means it can be tested without SQLite, and read
 * without reading any SQL.
 */

export const AUDIT_GENESIS_SEED = 'interlock-genesis-v1';

/** The prev_hash of seq 1. Nothing precedes it. */
export const AUDIT_GENESIS_HASH: string = sha256Hex(AUDIT_GENESIS_SEED);

/** hash = sha256(prev_hash + "\n" + canonicalJson({seq, ts, kind, payload})) */
export function auditHash(
  prevHash: string,
  seq: number,
  ts: number,
  kind: string,
  payload: unknown,
): string {
  return sha256Hex(`${prevHash}\n${canonicalJson({ seq, ts, kind, payload })}`);
}

/** A stored audit row, as it comes back off disk. */
export interface ChainRow {
  readonly seq: number;
  readonly ts: number;
  readonly kind: string;
  readonly payload_json: string;
  readonly prev_hash: string;
  readonly hash: string;
}

/**
 * Walk a chain from genesis and return the seq of the first record that does not
 * verify, or null if the whole chain holds.
 *
 * Four ways a record fails, in the order they are checked:
 *
 *  1. seq is not dense from 1 — a deleted, reordered or inserted row.
 *  2. prev_hash does not match the previous record's hash — the link is cut.
 *  3. payload_json is not already canonical — someone rewrote the bytes. Without
 *     this check, a payload re-serialised with the same values in a different
 *     key order would re-canonicalise to the original string and the hash would
 *     still match, so the edit would go unnoticed.
 *  4. the recomputed hash does not match the stored hash — a value changed.
 *
 * A forged record whose own hash is recomputed to match still fails at (2) on
 * the record after it, which is the point of chaining.
 */
export function verifyChainOver(rows: Iterable<ChainRow>): number | null {
  let expectedSeq = 1;
  let prevHash = AUDIT_GENESIS_HASH;

  for (const row of rows) {
    if (row.seq !== expectedSeq) return row.seq;
    if (row.prev_hash !== prevHash) return row.seq;

    try {
      const payload: unknown = JSON.parse(row.payload_json);
      if (canonicalJson(payload) !== row.payload_json) return row.seq;
      if (auditHash(prevHash, row.seq, row.ts, row.kind, payload) !== row.hash) return row.seq;
    } catch {
      // Unparseable, or a payload the canonicaliser refuses: itself a divergence.
      return row.seq;
    }

    prevHash = row.hash;
    expectedSeq += 1;
  }

  return null;
}

/** Build the next row in a chain. Used by the store; kept here beside verify. */
export function nextChainRow(
  previous: Pick<ChainRow, 'seq' | 'hash'> | undefined,
  ts: number,
  kind: string,
  payload: unknown,
): ChainRow {
  const seq = previous === undefined ? 1 : previous.seq + 1;
  const prevHash = previous === undefined ? AUDIT_GENESIS_HASH : previous.hash;
  return {
    seq,
    ts,
    kind,
    payload_json: canonicalJson(payload),
    prev_hash: prevHash,
    hash: auditHash(prevHash, seq, ts, kind, payload),
  };
}
