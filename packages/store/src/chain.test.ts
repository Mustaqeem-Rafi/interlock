import { canonicalJson, sha256Hex } from '@interlock/core';
import { describe, expect, it } from 'vitest';
import {
  AUDIT_GENESIS_HASH,
  AUDIT_GENESIS_SEED,
  auditHash,
  nextChainRow,
  verifyChainOver,
  type ChainRow,
} from './chain.js';

/**
 * These run without SQLite, so the tamper detection is exercised directly on
 * rows rather than through a database.
 */

const T0 = 1_757_000_000_000;

/** Build a well-formed chain of `n` records. */
function chain(n: number): ChainRow[] {
  const rows: ChainRow[] = [];
  for (let i = 0; i < n; i += 1) {
    const previous = rows.at(-1);
    rows.push(nextChainRow(previous, T0 + i, 'SEED', { i, note: 'original' }));
  }
  return rows;
}

describe('genesis', () => {
  it('is sha256("interlock-genesis-v1")', () => {
    expect(AUDIT_GENESIS_SEED).toBe('interlock-genesis-v1');
    expect(AUDIT_GENESIS_HASH).toBe(sha256Hex('interlock-genesis-v1'));
    expect(AUDIT_GENESIS_HASH).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is the prev_hash of seq 1', () => {
    expect(nextChainRow(undefined, T0, 'K', {}).prev_hash).toBe(AUDIT_GENESIS_HASH);
    expect(nextChainRow(undefined, T0, 'K', {}).seq).toBe(1);
  });
});

describe('auditHash', () => {
  it('is sha256(prev_hash + newline + canonicalJson({seq, ts, kind, payload}))', () => {
    const payload = { b: 2, a: 1 };
    const expected = sha256Hex(
      `${AUDIT_GENESIS_HASH}\n${canonicalJson({ seq: 1, ts: T0, kind: 'K', payload })}`,
    );
    expect(auditHash(AUDIT_GENESIS_HASH, 1, T0, 'K', payload)).toBe(expected);
  });

  it('does not depend on payload key order', () => {
    expect(auditHash(AUDIT_GENESIS_HASH, 1, T0, 'K', { a: 1, b: 2 })).toBe(
      auditHash(AUDIT_GENESIS_HASH, 1, T0, 'K', { b: 2, a: 1 }),
    );
  });

  it('changes with every input', () => {
    const base = auditHash(AUDIT_GENESIS_HASH, 1, T0, 'K', { a: 1 });
    expect(auditHash('f'.repeat(64), 1, T0, 'K', { a: 1 })).not.toBe(base);
    expect(auditHash(AUDIT_GENESIS_HASH, 2, T0, 'K', { a: 1 })).not.toBe(base);
    expect(auditHash(AUDIT_GENESIS_HASH, 1, T0 + 1, 'K', { a: 1 })).not.toBe(base);
    expect(auditHash(AUDIT_GENESIS_HASH, 1, T0, 'L', { a: 1 })).not.toBe(base);
    expect(auditHash(AUDIT_GENESIS_HASH, 1, T0, 'K', { a: 2 })).not.toBe(base);
  });
});

describe('verifyChainOver', () => {
  it('accepts an empty chain', () => {
    expect(verifyChainOver([])).toBeNull();
  });

  it('accepts an untouched chain', () => {
    expect(verifyChainOver(chain(25))).toBeNull();
  });

  it('produces a gapless seq from 1', () => {
    expect(chain(25).map((row) => row.seq)).toEqual(Array.from({ length: 25 }, (_, i) => i + 1));
  });

  it('links every record to its predecessor', () => {
    const rows = chain(5);
    for (let i = 1; i < rows.length; i += 1) {
      expect(rows[i]?.prev_hash).toBe(rows[i - 1]?.hash);
    }
  });

  it('catches an edited payload value at that seq', () => {
    const rows = chain(5);
    rows[2] = { ...rows[2]!, payload_json: canonicalJson({ i: 2, note: 'tampered' }) };
    expect(verifyChainOver(rows)).toBe(3);
  });

  it('catches a payload rewritten with the same values in another key order', () => {
    const rows = chain(5);
    // Same meaning, non-canonical bytes. Re-canonicalising would hide this, so
    // the check is on the stored bytes.
    rows[1] = { ...rows[1]!, payload_json: '{"note":"original","i":1}' };
    expect(verifyChainOver(rows)).toBe(2);
  });

  it('catches an edited timestamp', () => {
    const rows = chain(5);
    rows[3] = { ...rows[3]!, ts: rows[3]!.ts + 1 };
    expect(verifyChainOver(rows)).toBe(4);
  });

  it('catches an edited kind', () => {
    const rows = chain(5);
    rows[0] = { ...rows[0]!, kind: 'FORGED' };
    expect(verifyChainOver(rows)).toBe(1);
  });

  it('catches a deleted record as a gap at the next seq', () => {
    const rows = chain(5);
    rows.splice(2, 1);
    expect(verifyChainOver(rows)).toBe(4);
  });

  it('catches a reordered chain', () => {
    const rows = chain(5);
    const swapped = [rows[0]!, rows[2]!, rows[1]!, rows[3]!, rows[4]!];
    expect(verifyChainOver(swapped)).toBe(3);
  });

  it('catches a forged record whose own hash was recomputed', () => {
    const rows = chain(5);
    const target = rows[2]!;
    const payload = { i: 2, note: 'tampered' };
    // Internally consistent: prev_hash intact, hash recomputed over the forgery.
    rows[2] = {
      ...target,
      payload_json: canonicalJson(payload),
      hash: auditHash(target.prev_hash, target.seq, target.ts, target.kind, payload),
    };
    // Record 3 verifies on its own terms, so the break shows up at record 4,
    // whose prev_hash no longer matches. That is the chain doing its job.
    expect(verifyChainOver(rows)).toBe(4);
  });

  it('catches truncation plus re-forgery only if the tail is left behind', () => {
    const rows = chain(5).slice(0, 3);
    expect(verifyChainOver(rows)).toBeNull();
    // Truncating a suffix is undetectable from the chain alone; the head hash
    // has to be pinned elsewhere for that. Recorded here so the limit is known.
  });

  it('catches a ledger renumbered to hide a truncated head', () => {
    // Every record here is internally valid and correctly linked: the first one
    // even carries the genesis prev_hash. Only the fact that seq starts at 5
    // gives away that records 1-4 were dropped and the rest renumbered. Nothing
    // but the density check catches this.
    const rows: ChainRow[] = [];
    let prevHash = AUDIT_GENESIS_HASH;
    for (let seq = 5; seq <= 7; seq += 1) {
      const payload = { i: seq };
      const hash = auditHash(prevHash, seq, T0 + seq, 'SEED', payload);
      rows.push({
        seq,
        ts: T0 + seq,
        kind: 'SEED',
        payload_json: canonicalJson(payload),
        prev_hash: prevHash,
        hash,
      });
      prevHash = hash;
    }

    expect(verifyChainOver(rows)).toBe(5);
  });

  it('catches a prev_hash edited on its own', () => {
    // The recomputation uses the running previous hash, not the stored
    // prev_hash column, so a column edited in isolation is only caught by the
    // explicit link check.
    const rows = chain(4);
    rows[2] = { ...rows[2]!, prev_hash: 'f'.repeat(64) };
    expect(verifyChainOver(rows)).toBe(3);
  });

  it('separates the prev_hash from the payload with a newline', () => {
    // Without a separator, ("ab", "c") and ("a", "bc") would hash alike. The
    // spec fixes the separator as "\n"; this pins it.
    const payload = { a: 1 };
    expect(auditHash(AUDIT_GENESIS_HASH, 1, T0, 'K', payload)).not.toBe(
      sha256Hex(`${AUDIT_GENESIS_HASH}${canonicalJson({ seq: 1, ts: T0, kind: 'K', payload })}`),
    );
  });

  it('catches unparseable payload bytes', () => {
    const rows = chain(3);
    rows[1] = { ...rows[1]!, payload_json: '{not json' };
    expect(verifyChainOver(rows)).toBe(2);
  });

  it('catches a payload the canonicaliser refuses, such as a float', () => {
    const rows = chain(3);
    rows[1] = { ...rows[1]!, payload_json: '{"amount":1000.5}' };
    expect(verifyChainOver(rows)).toBe(2);
  });

  it('reports the first divergence when there are several', () => {
    const rows = chain(6);
    rows[4] = { ...rows[4]!, ts: 0 };
    rows[1] = { ...rows[1]!, ts: 0 };
    expect(verifyChainOver(rows)).toBe(2);
  });
});
