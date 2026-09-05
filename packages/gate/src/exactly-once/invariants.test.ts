import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InvariantViolation } from '@interlock/core';
import { openStore, type IntentRow, type NewIntent, type Store } from '@interlock/store';
import { RailTimeoutError } from '../rail/errors.js';
import { createMockRail, type MockRail } from '../rail/mock.js';
import { MACHINE_EVENTS, canTransition, nextState } from './machine.js';
import { propose } from './propose.js';
import { LEASE_MS, createWal, stampRefund, type IssueOutcome, type Wal } from './wal.js';

/** Narrow an outcome without a bare throw, so the assertions below typecheck. */
function assertKind<K extends IssueOutcome['kind']>(
  outcome: IssueOutcome,
  kind: K,
): asserts outcome is Extract<IssueOutcome, { kind: K }> {
  if (outcome.kind !== kind) {
    throw new InvariantViolation('test', `expected ${kind} but got ${outcome.kind}`);
  }
}

/**
 * One test per invariant in CLAUDE.md, named after the invariant.
 *
 * These drive the real store on a real file, because four of the six are only
 * meaningful against a database that actually fsyncs.
 */

const SIK = 'A'.repeat(32);
const HASH = 'a'.repeat(64);
const T0 = 1_757_000_000_000;

let dir: string;
let dbPath: string;
let store: Store;
let rail: MockRail;
let wal: Wal;
let paymentId: string;
let clock: number;

function newIntent(overrides: Partial<NewIntent> = {}): NewIntent {
  return {
    merchant_id: 'acc_KtqXyZ01',
    sik: SIK,
    tool: 'create_refund',
    subject_id: paymentId,
    amount_minor: 250_000,
    currency: 'INR',
    reversibility: 'irreversible',
    params_hash: HASH,
    mandate_hash: 'b'.repeat(64),
    at: T0,
    ...overrides,
  };
}

/** Drive an intent from PROPOSED to AUTHORIZED, as the ladder would. */
function authorize(intent: IntentRow): IntentRow {
  return store.intents.transition({
    merchant_id: intent.merchant_id,
    sik: intent.sik,
    from: 'PROPOSED',
    to: nextState('PROPOSED', 'GATES_PASSED'),
    at: (clock += 1),
    audit_kind: 'GATES_PASSED',
  });
}

function setUp(faults: Parameters<typeof createMockRail>[0] = {}): void {
  clock = T0;
  rail = createMockRail({ ...faults, now: () => clock });
  paymentId = rail.seedPayment({ amount_minor: 1_000_000 }).id;
  wal = createWal({ store, rail, now: () => clock, owner: 'worker-under-test' });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'interlock-invariants-'));
  dbPath = join(dir, 'interlock.db');
  store = openStore(dbPath);
  setUp();
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('CLAUDE.md invariants', () => {
  it('I1: at most one intent per (merchant_id, sik), enforced by a PRIMARY KEY not a lock', () => {
    const first = propose(store, newIntent());
    expect(first.disposition.kind).toBe('CREATED');

    // The same meaning proposed again. The INSERT loses on the primary key;
    // nothing checked-then-wrote, so there is no window to race through.
    const second = propose(store, newIntent({ at: T0 + 1 }));
    expect(second.disposition).toEqual({ kind: 'HOLD', reason: 'DUPLICATE_IN_PROGRESS' });

    const raw = new Database(dbPath);
    const { n } = raw
      .prepare('SELECT COUNT(*) AS n FROM intents WHERE merchant_id = ? AND sik = ?')
      .get('acc_KtqXyZ01', SIK) as { n: number };
    raw.close();
    expect(n).toBe(1);

    // And the loser sees the winner's row, not a copy of its own proposal.
    expect(second.intent.first_seen_at).toBe(first.intent.first_seen_at);
  });

  it('I2: no rail call is issued unless a durable IN_FLIGHT row exists on disk first', async () => {
    const authorized = authorize(propose(store, newIntent()).intent);

    let stateSeenOnDiskDuringCall: string | undefined;
    let attemptRowSeenDuringCall: number | undefined;

    // Read the ledger from a *separate connection* at the moment the rail is
    // touched. A separate connection cannot see an uncommitted transaction, so
    // anything it reads is genuinely committed and fsynced.
    const observing = {
      ...rail,
      createRefund: async (request: Parameters<MockRail['createRefund']>[0]) => {
        const raw = new Database(dbPath, { readonly: true });
        const row = raw
          .prepare('SELECT state FROM intents WHERE merchant_id = ? AND sik = ?')
          .get('acc_KtqXyZ01', SIK) as { state: string } | undefined;
        const attempt = raw
          .prepare('SELECT COUNT(*) AS n FROM intent_attempts WHERE sik = ?')
          .get(SIK) as { n: number };
        raw.close();
        stateSeenOnDiskDuringCall = row?.state;
        attemptRowSeenDuringCall = attempt.n;
        return rail.createRefund(request);
      },
    };

    const walUnderTest = createWal({
      store,
      rail: observing,
      now: () => clock,
      owner: 'worker-under-test',
    });
    const outcome = await walUnderTest.issueRefund(authorized);

    expect(stateSeenOnDiskDuringCall).toBe('IN_FLIGHT');
    expect(attemptRowSeenDuringCall).toBe(1);
    expect(outcome.kind).toBe('APPLIED');
  });

  it('I3: a retry is issued only from CONFIRMED_NOT_APPLIED; a timeout reconciles instead', async () => {
    setUp({ faults: { ambiguous_504: {} } });
    const authorized = authorize(propose(store, newIntent()).intent);

    const outcome = await wal.issueRefund(authorized);

    // The money moved. We were not told.
    expect(rail.inspect.refundsForPayment(paymentId)).toHaveLength(1);
    expect(outcome.kind).toBe('UNKNOWN');
    expect(outcome.intent.state).toBe('UNKNOWN');

    // There is no edge from UNKNOWN back to a rail call, by any event.
    for (const event of MACHINE_EVENTS) {
      if (canTransition('UNKNOWN', event)) {
        expect(nextState('UNKNOWN', event)).not.toBe('IN_FLIGHT');
        expect(nextState('UNKNOWN', event)).not.toBe('AUTHORIZED');
      }
    }
    // The only way onward is to reconcile.
    expect(nextState('UNKNOWN', 'RECONCILE_STARTED')).toBe('RECONCILING');
    expect(nextState('RECONCILING', 'RECONCILE_CONFIRMED_ABSENT')).toBe('CONFIRMED_NOT_APPLIED');
    expect(nextState('CONFIRMED_NOT_APPLIED', 'RETRY_AUTHORIZED')).toBe('AUTHORIZED');

    // And the store refuses to move it as though it were retryable.
    expect(() =>
      store.intents.transition({
        merchant_id: 'acc_KtqXyZ01',
        sik: SIK,
        from: 'CONFIRMED_NOT_APPLIED',
        to: 'AUTHORIZED',
        at: clock + 1,
      }),
    ).toThrow(/is in state UNKNOWN/);
  });

  it('I4: APPLIED and BLOCKED are absorbing', async () => {
    const authorized = authorize(propose(store, newIntent()).intent);
    const outcome = await wal.issueRefund(authorized);
    expect(outcome.intent.state).toBe('APPLIED');

    // Nothing leaves either state, by any event, in the machine...
    for (const state of ['APPLIED', 'BLOCKED'] as const) {
      for (const event of MACHINE_EVENTS) {
        expect(canTransition(state, event)).toBe(false);
      }
    }

    // ...and the ledger will not be talked into it either.
    expect(() =>
      store.intents.transition({
        merchant_id: 'acc_KtqXyZ01',
        sik: SIK,
        from: 'AUTHORIZED',
        to: 'IN_FLIGHT',
        at: clock + 1,
      }),
    ).toThrow(/is in state APPLIED/);

    // A second attempt cannot start from an applied intent.
    await expect(wal.issueRefund(outcome.intent)).rejects.toThrow(
      /only be issued from AUTHORIZED/,
    );
    expect(rail.inspect.refundsForPayment(paymentId)).toHaveLength(1);
  });

  it('I5: attempt_seq is strictly monotone per intent', async () => {
    setUp({ faults: { ambiguous_504: { on_calls: [1] } } });
    const authorized = authorize(propose(store, newIntent()).intent);

    const first = await wal.issueRefund(authorized);
    expect(first.intent.attempt_seq).toBe(1);

    // Walk the only legal route back to a second attempt.
    const reconciling = store.intents.transition({
      merchant_id: 'acc_KtqXyZ01',
      sik: SIK,
      from: 'UNKNOWN',
      to: nextState('UNKNOWN', 'RECONCILE_STARTED'),
      at: (clock += 1),
      audit_kind: 'RECONCILE_STARTED',
    });
    const absent = store.intents.transition({
      merchant_id: reconciling.merchant_id,
      sik: reconciling.sik,
      from: 'RECONCILING',
      to: nextState('RECONCILING', 'RECONCILE_CONFIRMED_ABSENT'),
      at: (clock += 1),
      audit_kind: 'RECONCILE_CONFIRMED_ABSENT',
    });
    const retry = store.intents.transition({
      merchant_id: absent.merchant_id,
      sik: absent.sik,
      from: 'CONFIRMED_NOT_APPLIED',
      to: nextState('CONFIRMED_NOT_APPLIED', 'RETRY_AUTHORIZED'),
      at: (clock += 1),
      audit_kind: 'RETRY_AUTHORIZED',
    });

    const second = await wal.issueRefund(retry);
    expect(second.intent.attempt_seq).toBe(2);

    const seqs = store.intents.attempts('acc_KtqXyZ01', SIK).map((a) => a.attempt_seq);
    expect(seqs).toEqual([1, 2]);
    for (let i = 1; i < seqs.length; i += 1) {
      expect(seqs[i]!).toBeGreaterThan(seqs[i - 1]!);
    }
  });

  it('I6: every state change appends exactly one audit record and seq is gapless', async () => {
    const created = propose(store, newIntent());
    expect(store.audit.count()).toBe(1);

    const before = store.audit.count();
    const authorized = authorize(created.intent);
    expect(store.audit.count()).toBe(before + 1);

    await wal.issueRefund(authorized);

    const records = store.audit.read(1, 1000);
    expect(records.map((r) => r.seq)).toEqual(
      Array.from({ length: records.length }, (_, i) => i + 1),
    );
    expect(records.map((r) => r.kind)).toEqual([
      'INTENT_CREATED',
      'GATES_PASSED',
      'ATTEMPT_STARTED',
      'ATTEMPT_FINISHED',
      'RAIL_APPLIED',
    ]);
    expect(store.audit.verifyChain()).toBeNull();
  });
});

describe('acceptance: a repeat proposal returns the original rail entity', () => {
  it('hands back the first refund instead of creating a second intent', async () => {
    const first = propose(store, newIntent());
    expect(first.disposition.kind).toBe('CREATED');

    const outcome = await wal.issueRefund(authorize(first.intent));
    expect(outcome.kind).toBe('APPLIED');
    assertKind(outcome, 'APPLIED');
    const originalEntityId = outcome.refund.id;
    expect(originalEntityId).toBe('rfnd_MOCK0000000001');

    // The agent asks for the same refund again, in whatever words.
    const second = propose(store, newIntent({ at: T0 + 500 }));

    expect(second.disposition).toEqual({
      kind: 'BLOCK',
      reason: 'ALREADY_APPLIED',
      rail_entity_id: originalEntityId,
    });

    // No second intent, and above all no second movement of money.
    const raw = new Database(dbPath, { readonly: true });
    const { n } = raw.prepare('SELECT COUNT(*) AS n FROM intents').get() as { n: number };
    raw.close();
    expect(n).toBe(1);
    expect(rail.inspect.refundsForPayment(paymentId)).toHaveLength(1);
    expect(rail.inspect.callCount('createRefund')).toBe(1);
  });
});

describe('the propose path', () => {
  it('holds while an attempt is in flight, unknown or reconciling', () => {
    const siks = {
      IN_FLIGHT: 'INFLIGHT'.padEnd(32, 'X'),
      UNKNOWN: 'UNKNOWN'.padEnd(32, 'X'),
      RECONCILING: 'RECONCILING'.padEnd(32, 'X'),
    } as const;
    for (const state of ['IN_FLIGHT', 'UNKNOWN', 'RECONCILING'] as const) {
      const sik = siks[state];
      propose(store, newIntent({ sik }));
      // Move it there the long way round so the states are reached legally.
      store.intents.transition({
        merchant_id: 'acc_KtqXyZ01',
        sik,
        from: 'PROPOSED',
        to: 'AUTHORIZED',
        at: (clock += 1),
      });
      if (state !== 'IN_FLIGHT') {
        store.intents.startAttempt({
          merchant_id: 'acc_KtqXyZ01',
          sik,
          from: 'AUTHORIZED',
          at: (clock += 1),
          request: {},
          lease_owner: 'w',
          lease_ms: 1000,
        });
        store.intents.transition({
          merchant_id: 'acc_KtqXyZ01',
          sik,
          from: 'IN_FLIGHT',
          to: 'UNKNOWN',
          at: (clock += 1),
        });
        if (state === 'RECONCILING') {
          store.intents.transition({
            merchant_id: 'acc_KtqXyZ01',
            sik,
            from: 'UNKNOWN',
            to: 'RECONCILING',
            at: (clock += 1),
          });
        }
      } else {
        store.intents.startAttempt({
          merchant_id: 'acc_KtqXyZ01',
          sik,
          from: 'AUTHORIZED',
          at: (clock += 1),
          request: {},
          lease_owner: 'w',
          lease_ms: 1000,
        });
      }

      const again = propose(store, newIntent({ sik, at: (clock += 1) }));
      expect(again.disposition).toEqual({ kind: 'HOLD', reason: 'DUPLICATE_IN_PROGRESS' });
      expect(again.intent.state).toBe(state);
    }
  });

  it('reopens from CONFIRMED_NOT_APPLIED as AUTHORIZED', () => {
    const sik = 'C'.repeat(32);
    propose(store, newIntent({ sik }));
    for (const [from, to] of [
      ['PROPOSED', 'AUTHORIZED'],
      ['AUTHORIZED', 'IN_FLIGHT'],
      ['IN_FLIGHT', 'UNKNOWN'],
      ['UNKNOWN', 'RECONCILING'],
      ['RECONCILING', 'CONFIRMED_NOT_APPLIED'],
    ] as const) {
      store.intents.transition({
        merchant_id: 'acc_KtqXyZ01',
        sik,
        from,
        to,
        at: (clock += 1),
      });
    }

    const reopened = propose(store, newIntent({ sik, at: (clock += 1) }));
    expect(reopened.disposition).toEqual({ kind: 'REOPENED', from: 'CONFIRMED_NOT_APPLIED' });
    expect(reopened.intent.state).toBe('AUTHORIZED');
  });

  it('reopens from FAILED_TERMINAL as AUTHORIZED', () => {
    const sik = 'F'.repeat(32);
    propose(store, newIntent({ sik }));
    for (const [from, to] of [
      ['PROPOSED', 'AUTHORIZED'],
      ['AUTHORIZED', 'IN_FLIGHT'],
      ['IN_FLIGHT', 'FAILED_TERMINAL'],
    ] as const) {
      store.intents.transition({
        merchant_id: 'acc_KtqXyZ01',
        sik,
        from,
        to,
        at: (clock += 1),
      });
    }

    const reopened = propose(store, newIntent({ sik, at: (clock += 1) }));
    expect(reopened.disposition).toEqual({ kind: 'REOPENED', from: 'FAILED_TERMINAL' });
    expect(reopened.intent.state).toBe('AUTHORIZED');
  });

  it('blocks on an already blocked intent and holds on a held one', () => {
    const blockedSik = 'B'.repeat(32);
    propose(store, newIntent({ sik: blockedSik }));
    store.intents.transition({
      merchant_id: 'acc_KtqXyZ01',
      sik: blockedSik,
      from: 'PROPOSED',
      to: 'BLOCKED',
      at: (clock += 1),
    });
    expect(propose(store, newIntent({ sik: blockedSik, at: clock })).disposition).toEqual({
      kind: 'BLOCK',
      reason: 'ALREADY_BLOCKED',
      rail_entity_id: null,
    });

    const heldSik = 'H'.repeat(32);
    propose(store, newIntent({ sik: heldSik }));
    store.intents.transition({
      merchant_id: 'acc_KtqXyZ01',
      sik: heldSik,
      from: 'PROPOSED',
      to: 'HELD',
      at: (clock += 1),
    });
    expect(propose(store, newIntent({ sik: heldSik, at: clock })).disposition).toEqual({
      kind: 'HOLD',
      reason: 'HELD_AWAITING_HUMAN',
    });
  });
});

describe('the write-ahead stamp', () => {
  it('stamps receipt and notes.interlock_sik on every outbound refund', async () => {
    const authorized = authorize(propose(store, newIntent()).intent);
    await wal.issueRefund(authorized);

    const [refund] = rail.inspect.refundsForPayment(paymentId);
    expect(refund?.receipt).toBe(`ilk_${SIK}`);
    expect(refund?.notes['interlock_sik']).toBe(SIK);
  });

  it('takes a 30 second lease under this process id', async () => {
    setUp({ faults: { ambiguous_504: {} } });
    const authorized = authorize(propose(store, newIntent()).intent);
    await wal.issueRefund(authorized);

    const raw = new Database(dbPath, { readonly: true });
    const row = raw
      .prepare('SELECT lease_owner, lease_expires_at FROM intents WHERE sik = ?')
      .get(SIK) as { lease_owner: string; lease_expires_at: number };
    raw.close();
    expect(row.lease_owner).toBe('worker-under-test');
    // The lease runs 30 seconds from when the attempt started, not from T0.
    const [attempt] = store.intents.attempts('acc_KtqXyZ01', SIK);
    expect(row.lease_expires_at).toBe(attempt!.started_at + LEASE_MS);
    expect(LEASE_MS).toBe(30_000);
  });

  it('cannot be told to skip the stamp, because there is nowhere to say it', () => {
    // The only way to build a request is stampRefund, and caller notes are
    // merged *under* the stamp rather than over it.
    const request = stampRefund(SIK, 'pay_1', 1000, {
      notes: { interlock_sik: 'FORGED', memo: 'kept' },
    });
    expect(request.receipt).toBe(`ilk_${SIK}`);
    expect(request.notes?.['interlock_sik']).toBe(SIK);
    expect(request.notes?.['memo']).toBe('kept');
  });

  it('records an ambiguous outcome as ambiguous, not as a failure', async () => {
    setUp({ faults: { ambiguous_504: {} } });
    const authorized = authorize(propose(store, newIntent()).intent);
    const outcome = await wal.issueRefund(authorized);

    assertKind(outcome, 'UNKNOWN');
    expect(outcome.error).toBeInstanceOf(RailTimeoutError);
    const [attempt] = store.intents.attempts('acc_KtqXyZ01', SIK);
    expect(attempt?.outcome).toBe('AMBIGUOUS');
    expect(attempt?.finished_at).not.toBeNull();
  });

  it('surfaces expired leases to the recovery sweep', async () => {
    setUp({ faults: { ambiguous_504: {} } });
    const authorized = authorize(propose(store, newIntent()).intent);
    // Leave it IN_FLIGHT by crashing before the outcome is recorded.
    store.intents.startAttempt({
      merchant_id: authorized.merchant_id,
      sik: authorized.sik,
      from: 'AUTHORIZED',
      at: clock,
      request: stampRefund(SIK, paymentId, 250_000),
      lease_owner: 'dead-worker',
      lease_ms: 30_000,
    });

    expect(wal.expiredLeases()).toHaveLength(0);
    clock = T0 + 31_000;
    const expired = wal.expiredLeases();
    expect(expired).toHaveLength(1);
    expect(expired[0]?.state).toBe('IN_FLIGHT');
    expect(nextState('IN_FLIGHT', 'LEASE_EXPIRED')).toBe('UNKNOWN');
  });
});
