import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sikReceipt } from '@interlock/core';
import { openStore, type IntentRow, type NewIntent, type Store } from '@interlock/store';
import { RailUnavailableError } from '../rail/errors.js';
import { createMockRail, type MockRail } from '../rail/mock.js';
import type { Refund } from '../rail/rail.js';
import { nextState } from './machine.js';
import { propose } from './propose.js';
import {
  MAX_RECONCILE_ATTEMPTS,
  RECONCILE_MIN_DELAY_MS,
  backoffMs,
  createReconciler,
  matchesSik,
  scanForSik,
  sikOf,
  type Reconciler,
} from './reconciler.js';
import { createSweep } from './sweep.js';
import { createWal, type Wal } from './wal.js';

const T0 = 1_757_000_000_000;
const HASH = 'a'.repeat(64);
const MERCHANT = 'acc_KtqXyZ01';

/**
 * Base32 excludes 0, 1, 8 and 9, so digits cannot appear in a SIK. Encode the
 * counter as letters instead.
 */
const sikFor = (n: number): string =>
  `SIK${String(n).replace(/\d/g, (d) => 'ABCDEFGHIJ'[Number(d)] ?? 'A')}`.padEnd(32, 'X');

let dir: string;
let dbPath: string;
let store: Store;
let rail: MockRail;
let wal: Wal;
let reconciler: Reconciler;
let paymentId: string;
let clock: number;
let slept: number[];

function build(faults: Parameters<typeof createMockRail>[0] = {}): void {
  clock = T0;
  slept = [];
  const sleep = async (ms: number): Promise<void> => {
    slept.push(ms);
    clock += ms;
    return Promise.resolve();
  };
  rail = createMockRail({ ...faults, now: () => clock, sleep });
  paymentId = rail.seedPayment({ amount_minor: 100_000_000 }).id;
  wal = createWal({ store, rail, now: () => clock, owner: 'worker-1' });
  reconciler = createReconciler({
    store,
    rail,
    now: () => clock,
    sleep,
    owner: 'reconciler-1',
  });
}

function intentInput(n: number, amount = 340_000): NewIntent {
  return {
    merchant_id: MERCHANT,
    sik: sikFor(n),
    tool: 'create_refund',
    subject_id: paymentId,
    amount_minor: amount,
    currency: 'INR',
    reversibility: 'irreversible',
    params_hash: HASH,
    mandate_hash: 'b'.repeat(64),
    at: clock,
  };
}

/** propose -> gates pass -> issue. Returns the intent after the attempt. */
async function issue(n: number, amount?: number): Promise<IntentRow> {
  const created = propose(store, intentInput(n, amount));
  const authorized = store.intents.transition({
    merchant_id: MERCHANT,
    sik: sikFor(n),
    from: 'PROPOSED',
    to: nextState('PROPOSED', 'GATES_PASSED'),
    at: (clock += 1),
    audit_kind: 'GATES_PASSED',
  });
  void created;
  const outcome = await wal.issueRefund(authorized);
  return outcome.intent;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'interlock-recon-'));
  dbPath = join(dir, 'interlock.db');
  store = openStore(dbPath);
  build();
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('trap 3: amount is not an identity', () => {
  it('matches on the stamp and never on the amount', () => {
    const sik = sikFor(1);
    const base: Refund = {
      id: 'rfnd_1',
      entity: 'refund',
      payment_id: 'pay_1',
      amount_minor: 340_000,
      currency: 'INR',
      receipt: null,
      notes: {},
      status: 'processed',
      speed_processed: 'normal',
      fee_minor: null,
      tax_minor: null,
      created_at: T0,
    };

    expect(matchesSik({ ...base, notes: { interlock_sik: sik } }, sik)).toBe(true);
    expect(matchesSik({ ...base, receipt: sikReceipt(sik) }, sik)).toBe(true);

    // Same amount, same payment, different meaning. Must not match.
    expect(matchesSik(base, sik)).toBe(false);
    expect(matchesSik({ ...base, notes: { interlock_sik: sikFor(2) } }, sik)).toBe(false);
    expect(matchesSik({ ...base, receipt: sikReceipt(sikFor(2)) }, sik)).toBe(false);
  });

  it('recovers a sik from either the notes or the receipt', () => {
    const sik = sikFor(7);
    expect(sikOf({ notes: { interlock_sik: sik }, receipt: null } as unknown as Refund)).toBe(sik);
    expect(sikOf({ notes: {}, receipt: sikReceipt(sik) } as unknown as Refund)).toBe(sik);
    expect(sikOf({ notes: {}, receipt: 'someone_elses_receipt' } as unknown as Refund)).toBeNull();
    expect(sikOf({ notes: {}, receipt: null } as unknown as Refund)).toBeNull();
  });
});

describe('trap 2: the rail is not read-your-writes', () => {
  it('waits RECONCILE_MIN_DELAY_MS after the attempt before the first query', async () => {
    build({ faults: { ambiguous_504: {} } });
    const unknown = await issue(1);
    expect(unknown.state).toBe('UNKNOWN');

    const [attempt] = store.intents.attempts(MERCHANT, sikFor(1));
    const finishedAt = attempt!.finished_at!;

    let firstQueryAt: number | undefined;
    const observing = {
      ...rail,
      listRefundsForPayment: async (id: string, cursor?: string | null) => {
        firstQueryAt ??= clock;
        return rail.listRefundsForPayment(id, cursor);
      },
    };
    const patient = createReconciler({
      store,
      rail: observing,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
        return Promise.resolve();
      },
    });

    await patient.reconcile(unknown);
    expect(firstQueryAt).toBeGreaterThanOrEqual(finishedAt + RECONCILE_MIN_DELAY_MS);
    expect(RECONCILE_MIN_DELAY_MS).toBe(2_000);
  });
});

describe('trap 1: absence on page one is not absence', () => {
  it('is caught by seven refunds across three pages', async () => {
    // Six unrelated refunds land first, so the seventh — the one that times out
    // — sits on page three. A reconciler that reads page one and stops would
    // report it absent, retry, and refund twice.
    // The fault is aimed at the seventh createRefund call so the decoys land.
    build({ faults: { ambiguous_504: { on_calls: [7] } } });
    for (let i = 1; i <= 6; i += 1) {
      await rail.createRefund({
        payment_id: paymentId,
        amount_minor: 100_000 + i,
        receipt: sikReceipt(sikFor(i)),
        notes: { interlock_sik: sikFor(i) },
      });
    }
    const seventh = await issue(7, 340_000);
    expect(seventh.state).toBe('UNKNOWN');
    expect(rail.inspect.refundsForPayment(paymentId)).toHaveLength(7);

    const scan = await scanForSik(rail, paymentId, sikFor(7));
    expect(scan.status).toBe('FOUND');
    expect(scan.pages).toBe(3);

    const outcome = await reconciler.reconcile(seventh);
    expect(outcome.kind).toBe('APPLIED');
    expect(outcome.intent.state).toBe('APPLIED');

    const finding = store.recon.forIntent(MERCHANT, sikFor(7)).at(-1);
    expect(finding?.outcome).toBe('APPLIED');
    expect(finding?.pages_scanned).toBe(3);
  });

  it('only claims CONFIRMED_NOT_APPLIED after a pass reaches the last page', async () => {
    // Nothing was applied: the rail rejected before acting.
    const created = propose(store, intentInput(1));
    const authorized = store.intents.transition({
      merchant_id: MERCHANT,
      sik: sikFor(1),
      from: 'PROPOSED',
      to: 'AUTHORIZED',
      at: (clock += 1),
    });
    void created;
    // Six decoy refunds so absence has to be proven across three pages.
    for (let i = 10; i <= 15; i += 1) {
      await rail.createRefund({
        payment_id: paymentId,
        amount_minor: 100_000 + i,
        receipt: sikReceipt(sikFor(i)),
        notes: { interlock_sik: sikFor(i) },
      });
    }
    store.intents.startAttempt({
      merchant_id: MERCHANT,
      sik: sikFor(1),
      from: 'AUTHORIZED',
      at: (clock += 1),
      request: {},
      lease_owner: 'w',
      lease_ms: 30_000,
    });
    store.intents.finishAttempt({
      merchant_id: MERCHANT,
      sik: sikFor(1),
      attempt_seq: 1,
      at: (clock += 1),
      outcome: 'TIMEOUT',
    });
    const unknown = store.intents.transition({
      merchant_id: MERCHANT,
      sik: sikFor(1),
      from: 'IN_FLIGHT',
      to: 'UNKNOWN',
      at: (clock += 1),
    });
    void authorized;

    const outcome = await reconciler.reconcile(unknown);
    expect(outcome.kind).toBe('CONFIRMED_NOT_APPLIED');

    const finding = store.recon.forIntent(MERCHANT, sikFor(1)).at(-1);
    expect(finding?.outcome).toBe('CONFIRMED_NOT_APPLIED');
    expect(finding?.pagination_exhausted).toBe(1);
    expect(finding?.pages_scanned).toBe(2);
  });

  it('reports STILL_UNKNOWN when the walk cannot finish', async () => {
    build({ faults: { ambiguous_504: {} } });
    const unknown = await issue(1);

    // Partition opens after the attempt, so every page read fails.
    const partitioned = createReconciler({
      store,
      rail: {
        ...rail,
        listRefundsForPayment: () =>
          Promise.reject(new RailUnavailableError('listRefundsForPayment', 'partitioned')),
      },
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
        return Promise.resolve();
      },
    });

    const outcome = await partitioned.reconcile(unknown);
    expect(outcome.kind).toBe('STILL_UNKNOWN');
    expect(outcome.intent.state).toBe('UNKNOWN');

    const finding = store.recon.forIntent(MERCHANT, sikFor(1)).at(-1);
    expect(finding?.outcome).toBe('STILL_UNKNOWN');
    expect(finding?.pagination_exhausted).toBe(0);
  });
});

describe('backoff and quarantine', () => {
  it('backs off 2^n seconds capped at 60', () => {
    expect([1, 2, 3, 4, 5, 6, 7].map((n) => backoffMs(n) / 1000)).toEqual([
      2, 4, 8, 16, 32, 60, 60,
    ]);
  });

  it('a 90 second partition ends in QUARANTINED and never in a retry', async () => {
    build({ faults: { ambiguous_504: {}, partition: { from_ms: T0, for_ms: 90_000 } } });
    const unknown = await issue(1);
    expect(unknown.state).toBe('UNKNOWN');
    expect(rail.inspect.refundsForPayment(paymentId)).toHaveLength(1);

    const outcome = await reconciler.settle(unknown);

    expect(outcome.kind).toBe('QUARANTINED');
    expect(outcome.intent.state).toBe('QUARANTINED');
    expect(outcome.intent.reconcile_attempts).toBe(MAX_RECONCILE_ATTEMPTS);

    // Six passes, backing off 2, 4, 8, 16, 32 between them.
    expect(store.recon.forIntent(MERCHANT, sikFor(1))).toHaveLength(6);
    expect(slept.filter((ms) => ms >= 2_000)).toEqual(
      expect.arrayContaining([2_000, 4_000, 8_000, 16_000, 32_000]),
    );

    // The point of the whole exercise: still exactly one rail entity.
    expect(rail.inspect.callCount('createRefund')).toBe(1);
    expect(rail.inspect.refundsForPayment(paymentId)).toHaveLength(1);

    // And QUARANTINED cannot be talked into a retry.
    expect(store.intents.require(MERCHANT, sikFor(1)).state).toBe('QUARANTINED');
  });

  it('recovers if the partition lifts before the attempts run out', async () => {
    build({ faults: { ambiguous_504: {}, partition: { from_ms: T0, for_ms: 12_000 } } });
    const unknown = await issue(1);

    const outcome = await reconciler.settle(unknown);
    expect(outcome.kind).toBe('APPLIED');
    expect(rail.inspect.callCount('createRefund')).toBe(1);
  });
});

describe('the ambiguous-response protocol end to end', () => {
  it('a 504 never produces a second rail entity', async () => {
    build({ faults: { ambiguous_504: {} } });
    const unknown = await issue(1);

    expect(unknown.state).toBe('UNKNOWN');
    const outcome = await reconciler.settle(unknown);

    expect(outcome.kind).toBe('APPLIED');
    expect(rail.inspect.callCount('createRefund')).toBe(1);
    expect(rail.inspect.refundsForPayment(paymentId)).toHaveLength(1);
    expect(store.intents.attempts(MERCHANT, sikFor(1))).toHaveLength(1);
    expect(store.audit.verifyChain()).toBeNull();
  });

  it('records the rail entity it found so a later propose can return it', async () => {
    build({ faults: { ambiguous_504: {} } });
    const unknown = await issue(1);
    await reconciler.settle(unknown);

    const applied = store.intents.require(MERCHANT, sikFor(1));
    expect(applied.rail_entity_id).toBe('rfnd_MOCK0000000001');

    const again = propose(store, intentInput(1));
    expect(again.disposition).toEqual({
      kind: 'BLOCK',
      reason: 'ALREADY_APPLIED',
      rail_entity_id: 'rfnd_MOCK0000000001',
    });
    expect(rail.inspect.callCount('createRefund')).toBe(1);
  });

  it('leaves an already settled intent alone', async () => {
    build({ faults: { ambiguous_504: {} } });
    const unknown = await issue(1);
    await reconciler.settle(unknown);
    const outcome = await reconciler.reconcile(store.intents.require(MERCHANT, sikFor(1)));
    expect(outcome.kind).toBe('SETTLED');
  });
});

describe('acceptance: 50 refunds with ambiguous_504 on every call', () => {
  it('produces exactly 50 rail entities', async () => {
    build({ faults: { ambiguous_504: {} } });

    // All fifty against one payment, so by the end the reconciler is walking
    // seventeen pages to find the last stamp. Pagination is not incidental here.
    for (let n = 1; n <= 50; n += 1) {
      const unknown = await issue(n, 340_000 + n);
      expect(unknown.state).toBe('UNKNOWN');
      const outcome = await reconciler.settle(unknown);
      expect(outcome.kind).toBe('APPLIED');
    }

    expect(rail.inspect.refundsForPayment(paymentId)).toHaveLength(50);
    expect(rail.inspect.callCount('createRefund')).toBe(50);

    const intents = store.intents.list({ states: ['APPLIED'] });
    expect(intents).toHaveLength(50);
    for (const intent of intents) {
      expect(intent.attempt_seq).toBe(1);
      expect(intent.rail_entity_id).not.toBeNull();
    }

    // Every rail entity carries a distinct sik: no duplicates anywhere.
    const siks = rail.inspect.refunds().map((refund) => sikOf(refund));
    expect(new Set(siks).size).toBe(50);
    expect(siks.every((sik) => sik !== null)).toBe(true);

    // And the drift sweep agrees.
    const sweep = createSweep({ store, rail, now: () => clock, windowMs: 86_400_000 });
    const report = await sweep.runOnce();
    expect(report.complete).toBe(true);
    expect(report.duplicates).toEqual([]);
    expect(report.phantoms).toEqual([]);
    expect(report.orphans).toEqual([]);
    expect(report.scanned_entities).toBe(50);

    expect(store.audit.verifyChain()).toBeNull();
  }, 60_000);
});
