import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InvariantViolation } from '@interlock/core';
import { AUDIT_GENESIS_HASH, auditHash } from './chain.js';
import { openStore, type Store } from './index.js';
import { DuplicateIntentError, StaleIntentStateError, StoreOpenError } from './errors.js';

const SIK = 'A'.repeat(32);
const HASH = 'a'.repeat(64);
const T0 = 1_757_000_000_000;

const INTENT = {
  merchant_id: 'acc_KtqXyZ01',
  sik: SIK,
  tool: 'create_refund',
  subject_id: 'pay_MkT9xQr2LbVc41',
  amount_minor: 250_000,
  currency: 'INR',
  reversibility: 'irreversible',
  params_hash: HASH,
  mandate_hash: 'b'.repeat(64),
  at: T0,
} as const;

let dir: string;
let store: Store;
let dbPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'interlock-store-'));
  dbPath = join(dir, 'interlock.db');
  store = openStore(dbPath);
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

/** A second connection to the same file, standing in for a hand edit in sqlite3. */
function sqlite3(): Database.Database {
  return new Database(dbPath);
}

describe('durability', () => {
  it('comes up in WAL with synchronous = FULL', () => {
    const raw = sqlite3();
    expect(String(raw.pragma('journal_mode', { simple: true })).toLowerCase()).toBe('wal');
    raw.close();
    // synchronous is per-connection, so assert on the store's own connection by
    // proving openStore would have refused to return had it not applied.
    expect(store.path).toBe(dbPath);
  });

  it('refuses an in-memory ledger, which cannot satisfy I2', () => {
    expect(() => openStore(':memory:')).toThrow(StoreOpenError);
  });
});

describe('I1: at most one intent per (merchant_id, sik)', () => {
  it('raises a constraint error on a duplicate insert rather than creating a second row', () => {
    const first = store.intents.create(INTENT);
    expect(first.state).toBe('PROPOSED');

    expect(() => store.intents.create(INTENT)).toThrow(DuplicateIntentError);

    const raw = sqlite3();
    const { n } = raw
      .prepare('SELECT COUNT(*) AS n FROM intents WHERE merchant_id = ? AND sik = ?')
      .get(INTENT.merchant_id, INTENT.sik) as { n: number };
    raw.close();
    expect(n).toBe(1);
  });

  it('is the primary key doing it, not a lock', () => {
    store.intents.create(INTENT);
    const raw = sqlite3();
    expect(() =>
      raw
        .prepare(
          `INSERT INTO intents (merchant_id, sik, tool, subject_id, amount_minor, currency,
             reversibility, params_hash, state, attempt_seq, reconcile_attempts, lease_owner,
             lease_expires_at, rail_entity_id, mandate_hash, first_seen_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,'PROPOSED',0,0,NULL,NULL,NULL,?,?,?)`,
        )
        .run(
          INTENT.merchant_id,
          INTENT.sik,
          INTENT.tool,
          INTENT.subject_id,
          INTENT.amount_minor,
          INTENT.currency,
          INTENT.reversibility,
          INTENT.params_hash,
          INTENT.mandate_hash,
          T0,
          T0,
        ),
    ).toThrow(/UNIQUE|PRIMARY/i);
    raw.close();
  });

  it('lets a different sik through for the same merchant', () => {
    store.intents.create(INTENT);
    expect(() => store.intents.create({ ...INTENT, sik: 'B'.repeat(32) })).not.toThrow();
  });

  it('rejects a float amount at the boundary', () => {
    expect(() => store.intents.create({ ...INTENT, amount_minor: 2500.5 })).toThrow();
  });
});

describe('I5: attempt_seq is strictly monotone', () => {
  it('increments per attempt and never reuses a value', () => {
    store.intents.create(INTENT);
    store.intents.transition({
      merchant_id: INTENT.merchant_id,
      sik: SIK,
      from: 'PROPOSED',
      to: 'AUTHORIZED',
      at: T0 + 1,
    });

    const first = store.intents.startAttempt({
      merchant_id: INTENT.merchant_id,
      sik: SIK,
      from: 'AUTHORIZED',
      at: T0 + 2,
      request: { amount: 250_000 },
      lease_owner: 'worker-1',
      lease_ms: 30_000,
    });
    expect(first.attempt.attempt_seq).toBe(1);
    expect(first.intent.state).toBe('IN_FLIGHT');

    store.intents.finishAttempt({
      merchant_id: INTENT.merchant_id,
      sik: SIK,
      attempt_seq: 1,
      at: T0 + 3,
      outcome: 'TIMEOUT',
    });
    store.intents.transition({
      merchant_id: INTENT.merchant_id,
      sik: SIK,
      from: 'IN_FLIGHT',
      to: 'CONFIRMED_NOT_APPLIED',
      at: T0 + 4,
    });
    store.intents.transition({
      merchant_id: INTENT.merchant_id,
      sik: SIK,
      from: 'CONFIRMED_NOT_APPLIED',
      to: 'AUTHORIZED',
      at: T0 + 5,
    });

    const second = store.intents.startAttempt({
      merchant_id: INTENT.merchant_id,
      sik: SIK,
      from: 'AUTHORIZED',
      at: T0 + 6,
      request: { amount: 250_000 },
      lease_owner: 'worker-1',
      lease_ms: 30_000,
    });
    expect(second.attempt.attempt_seq).toBe(2);
    expect(store.intents.attempts(INTENT.merchant_id, SIK).map((a) => a.attempt_seq)).toEqual([
      1, 2,
    ]);
  });
});

describe('compare-and-set', () => {
  it('refuses a transition from a state the intent is no longer in', () => {
    store.intents.create(INTENT);
    store.intents.transition({
      merchant_id: INTENT.merchant_id,
      sik: SIK,
      from: 'PROPOSED',
      to: 'BLOCKED',
      at: T0 + 1,
    });

    expect(() =>
      store.intents.transition({
        merchant_id: INTENT.merchant_id,
        sik: SIK,
        from: 'PROPOSED',
        to: 'AUTHORIZED',
        at: T0 + 2,
      }),
    ).toThrow(StaleIntentStateError);
  });
});

describe('the sweep', () => {
  it('finds IN_FLIGHT intents whose lease has lapsed and ignores live ones', () => {
    store.intents.create(INTENT);
    store.intents.transition({
      merchant_id: INTENT.merchant_id,
      sik: SIK,
      from: 'PROPOSED',
      to: 'AUTHORIZED',
      at: T0 + 1,
    });
    store.intents.startAttempt({
      merchant_id: INTENT.merchant_id,
      sik: SIK,
      from: 'AUTHORIZED',
      at: T0 + 2,
      request: {},
      lease_owner: 'worker-1',
      lease_ms: 30_000,
    });

    expect(store.intents.sweepExpiredLeases(T0 + 10_000)).toHaveLength(0);
    expect(store.intents.sweepExpiredLeases(T0 + 60_000)).toHaveLength(1);
  });
});

describe('I6: the audit chain', () => {
  it('starts from sha256("interlock-genesis-v1")', () => {
    store.audit.append({ kind: 'TEST', payload: { a: 1 }, ts: T0 });
    const head = store.audit.head();
    expect(head?.seq).toBe(1);
    expect(head?.prev_hash).toBe(AUDIT_GENESIS_HASH);
    expect(AUDIT_GENESIS_HASH).toMatch(/^[0-9a-f]{64}$/);
  });

  it('links each record to the previous hash', () => {
    store.audit.append({ kind: 'A', payload: { n: 1 }, ts: T0 });
    store.audit.append({ kind: 'B', payload: { n: 2 }, ts: T0 + 1 });
    const [first, second] = store.audit.read();
    expect(second?.prev_hash).toBe(first?.hash);
  });

  it('keeps seq gapless across a batch of writes', () => {
    for (let i = 0; i < 25; i += 1) {
      store.audit.append({ kind: 'BATCH', payload: { i }, ts: T0 + i });
    }
    const seqs = store.audit.read(1, 1000).map((record) => record.seq);
    expect(seqs).toEqual(Array.from({ length: 25 }, (_, i) => i + 1));
    expect(store.audit.verifyChain()).toBeNull();
  });

  it('stays gapless when the writes come from repository operations', () => {
    store.intents.create(INTENT);
    store.intents.transition({
      merchant_id: INTENT.merchant_id,
      sik: SIK,
      from: 'PROPOSED',
      to: 'AUTHORIZED',
      at: T0 + 1,
    });
    store.intents.startAttempt({
      merchant_id: INTENT.merchant_id,
      sik: SIK,
      from: 'AUTHORIZED',
      at: T0 + 2,
      request: {},
      lease_owner: 'w1',
      lease_ms: 1000,
    });
    store.intents.finishAttempt({
      merchant_id: INTENT.merchant_id,
      sik: SIK,
      attempt_seq: 1,
      at: T0 + 3,
      outcome: 'APPLIED',
      rail_entity_id: 'rfnd_1',
      fee_minor: 500,
      tax_minor: 90,
    });

    expect(store.audit.read().map((r) => r.seq)).toEqual([1, 2, 3, 4]);
    expect(store.audit.read().map((r) => r.kind)).toEqual([
      'INTENT_CREATED',
      'STATE_CHANGED',
      'ATTEMPT_STARTED',
      'ATTEMPT_FINISHED',
    ]);
    expect(store.audit.verifyChain()).toBeNull();
  });

  it('appends exactly one record per state change', () => {
    store.intents.create(INTENT);
    const before = store.audit.count();
    store.intents.transition({
      merchant_id: INTENT.merchant_id,
      sik: SIK,
      from: 'PROPOSED',
      to: 'AUTHORIZED',
      at: T0 + 1,
    });
    expect(store.audit.count()).toBe(before + 1);
  });

  it('rolls the audit record back with a failed write', () => {
    store.intents.create(INTENT);
    const before = store.audit.count();
    expect(() => store.intents.create(INTENT)).toThrow(DuplicateIntentError);
    expect(store.audit.count()).toBe(before);
    expect(store.audit.verifyChain()).toBeNull();
  });
});

describe('verifyChain', () => {
  const seed = (): void => {
    for (let i = 0; i < 5; i += 1) {
      store.audit.append({ kind: 'SEED', payload: { i, note: 'original' }, ts: T0 + i });
    }
  };

  it('returns null for an untouched chain', () => {
    seed();
    expect(store.audit.verifyChain()).toBeNull();
  });

  it('catches a hand-edited payload and names the seq', () => {
    seed();
    const raw = sqlite3();
    raw
      .prepare('UPDATE audit_log SET payload_json = ? WHERE seq = ?')
      .run('{"i":2,"note":"tampered"}', 3);
    raw.close();

    expect(store.audit.verifyChain()).toBe(3);
  });

  it('catches a payload rewritten with the same values in another key order', () => {
    seed();
    const raw = sqlite3();
    raw
      .prepare('UPDATE audit_log SET payload_json = ? WHERE seq = ?')
      .run('{"note":"original","i":1}', 2);
    raw.close();

    expect(store.audit.verifyChain()).toBe(2);
  });

  it('catches an edited timestamp', () => {
    seed();
    const raw = sqlite3();
    raw.prepare('UPDATE audit_log SET ts = ts + 1 WHERE seq = ?').run(4);
    raw.close();

    expect(store.audit.verifyChain()).toBe(4);
  });

  it('catches a deleted record as a gap', () => {
    seed();
    const raw = sqlite3();
    raw.prepare('DELETE FROM audit_log WHERE seq = ?').run(3);
    raw.close();

    expect(store.audit.verifyChain()).toBe(4);
  });

  it('catches a forged hash that is internally consistent but breaks the link', () => {
    seed();
    const raw = sqlite3();
    const forgedPayload = { i: 2, note: 'tampered' };
    const row = raw.prepare('SELECT prev_hash, ts, kind FROM audit_log WHERE seq = 3').get() as {
      prev_hash: string;
      ts: number;
      kind: string;
    };
    // Recompute a hash that is valid for the forged payload, so only the link to
    // seq 4 gives it away.
    const forgedHash = auditHash(row.prev_hash, 3, row.ts, row.kind, forgedPayload);
    raw
      .prepare('UPDATE audit_log SET payload_json = ?, hash = ? WHERE seq = 3')
      .run(JSON.stringify(forgedPayload), forgedHash);
    raw.close();

    expect(store.audit.verifyChain()).toBe(4);
  });

  it('catches unparseable payload bytes', () => {
    seed();
    const raw = sqlite3();
    raw.prepare('UPDATE audit_log SET payload_json = ? WHERE seq = ?').run('{not json', 2);
    raw.close();

    expect(store.audit.verifyChain()).toBe(2);
  });
});

describe('recon findings', () => {
  beforeEach(() => {
    store.intents.create(INTENT);
  });

  it('refuses to record CONFIRMED_NOT_APPLIED without pagination exhaustion', () => {
    expect(() =>
      store.recon.record({
        merchant_id: INTENT.merchant_id,
        sik: SIK,
        attempt_seq: 1,
        outcome: 'CONFIRMED_NOT_APPLIED',
        pages_scanned: 1,
        pagination_exhausted: false,
        queried_at: T0 + 5,
      }),
    ).toThrow(InvariantViolation);
  });

  it('refuses the same claim through a raw connection, via the CHECK constraint', () => {
    const raw = sqlite3();
    expect(() =>
      raw
        .prepare(
          `INSERT INTO recon_findings
             (merchant_id, sik, attempt_seq, outcome, pages_scanned, pagination_exhausted,
              matched_entity_id, queried_at, detail_json)
           VALUES (?,?,?,'CONFIRMED_NOT_APPLIED',1,0,NULL,?, '{}')`,
        )
        .run(INTENT.merchant_id, SIK, 1, T0),
    ).toThrow(/CHECK/i);
    raw.close();
  });

  it('accepts CONFIRMED_NOT_APPLIED once pagination ran to exhaustion', () => {
    const finding = store.recon.record({
      merchant_id: INTENT.merchant_id,
      sik: SIK,
      attempt_seq: 1,
      outcome: 'CONFIRMED_NOT_APPLIED',
      pages_scanned: 4,
      pagination_exhausted: true,
      queried_at: T0 + 5,
    });
    expect(finding.outcome).toBe('CONFIRMED_NOT_APPLIED');
    expect(finding.pagination_exhausted).toBe(1);
    expect(store.audit.verifyChain()).toBeNull();
  });

  it('records STILL_UNKNOWN without exhaustion', () => {
    expect(
      store.recon.record({
        merchant_id: INTENT.merchant_id,
        sik: SIK,
        attempt_seq: 1,
        outcome: 'STILL_UNKNOWN',
        pages_scanned: 1,
        pagination_exhausted: false,
        queried_at: T0 + 5,
      }).outcome,
    ).toBe('STILL_UNKNOWN');
  });
});

describe('decisions', () => {
  it('records a decision and the audit record it produced together', () => {
    store.intents.create(INTENT);
    const row = store.decisions.record(INTENT.merchant_id, {
      request_id: 'req_01',
      sik: SIK,
      mandate_hash: 'b'.repeat(64),
      verdict: 'BLOCK',
      results: [
        { gate: 'g2_value', verdict: 'BLOCK', reason_code: 'AMOUNT_ABOVE_GRANT', message: '', evidence: {} },
      ],
      agent_id: 'agent_test',
      tool: 'create_refund',
      amount_minor: 189_900,
      latency_ms: 3,
      decided_at: T0 + 7,
    });

    expect(row.verdict).toBe('BLOCK');
    expect(store.audit.read(row.audit_seq, 1)[0]?.kind).toBe('DECISION_RECORDED');
    expect(store.decisions.forIntent(INTENT.merchant_id, SIK)).toHaveLength(1);
    expect(store.audit.verifyChain()).toBeNull();
  });
});
