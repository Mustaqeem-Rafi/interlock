import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sikReceipt } from '@interlock/core';
import { openStore, type NewIntent, type Store } from '@interlock/store';
import { RailUnavailableError } from '../rail/errors.js';
import { createMockRail, type MockRail } from '../rail/mock.js';
import { createReconciler, type Reconciler } from './reconciler.js';
import { RECOVERY_REASON, createRecovery, type Readiness } from './recovery.js';
import { createSweep } from './sweep.js';
import { propose } from './propose.js';

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
let reconciler: Reconciler;
let paymentId: string;
let clock: number;

const sleep = async (ms: number): Promise<void> => {
  clock += ms;
  return Promise.resolve();
};

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

/**
 * Leave an intent stranded exactly as a killed process would: IN_FLIGHT with a
 * lease nobody will renew, and — if `applyUpstream` — the money already gone.
 */
async function strandInFlight(n: number, applyUpstream: boolean): Promise<void> {
  propose(store, intentInput(n));
  store.intents.transition({
    merchant_id: MERCHANT,
    sik: sikFor(n),
    from: 'PROPOSED',
    to: 'AUTHORIZED',
    at: (clock += 1),
  });
  store.intents.startAttempt({
    merchant_id: MERCHANT,
    sik: sikFor(n),
    from: 'AUTHORIZED',
    at: (clock += 1),
    request: {},
    lease_owner: 'dead-worker',
    lease_ms: 30_000,
  });
  if (applyUpstream) {
    await rail.createRefund({
      payment_id: paymentId,
      amount_minor: 340_000,
      receipt: sikReceipt(sikFor(n)),
      notes: { interlock_sik: sikFor(n) },
    });
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'interlock-recovery-'));
  dbPath = join(dir, 'interlock.db');
  store = openStore(dbPath);
  clock = T0;
  rail = createMockRail({ now: () => clock, sleep });
  paymentId = rail.seedPayment({ amount_minor: 100_000_000 }).id;
  reconciler = createReconciler({ store, rail, now: () => clock, sleep, owner: 'recon' });
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('boot recovery', () => {
  it('is not ready before it has run, and reports the count outstanding', async () => {
    await strandInFlight(1, true);
    await strandInFlight(2, false);
    clock = T0 + 60_000; // both leases have lapsed

    const recovery = createRecovery({ store, reconciler, now: () => clock });

    // Before run(): 503, because serving traffic now is how a refund goes twice.
    expect(recovery.readiness()).toEqual({
      ready: false,
      phase: 'scanning',
      outstanding: 0,
      status: 503,
    });

    const report = await recovery.run();

    expect(report.recovered).toBe(2);
    expect(report.applied).toBe(1);
    expect(report.confirmed_not_applied).toBe(1);
    expect(recovery.readiness()).toEqual({
      ready: true,
      phase: 'ready',
      outstanding: 0,
      status: 200,
    });
  });

  it('moves stranded intents to UNKNOWN with reason RECOVERED_AFTER_RESTART', async () => {
    await strandInFlight(1, true);
    clock = T0 + 60_000;

    const recovery = createRecovery({ store, reconciler, now: () => clock });
    await recovery.run();

    const records = store.audit.read(1, 1000);
    const recoveryRecord = records.find((r) => r.kind === RECOVERY_REASON);
    expect(recoveryRecord).toBeDefined();
    expect(recoveryRecord?.payload).toMatchObject({
      reason: 'RECOVERED_AFTER_RESTART',
      from: 'IN_FLIGHT',
      via: 'LEASE_EXPIRED',
      stale_lease_owner: 'dead-worker',
    });
    expect(store.audit.verifyChain()).toBeNull();
  });

  it('reconciles a stranded intent whose money did move, without moving it again', async () => {
    await strandInFlight(1, true);
    clock = T0 + 60_000;
    const callsBefore = rail.inspect.callCount('createRefund');

    await createRecovery({ store, reconciler, now: () => clock }).run();

    const intent = store.intents.require(MERCHANT, sikFor(1));
    expect(intent.state).toBe('APPLIED');
    expect(intent.rail_entity_id).toBe('rfnd_MOCK0000000001');
    expect(rail.inspect.callCount('createRefund')).toBe(callsBefore);
    expect(rail.inspect.refundsForPayment(paymentId)).toHaveLength(1);
  });

  it('takes a stranded intent whose money did not move to CONFIRMED_NOT_APPLIED', async () => {
    await strandInFlight(1, false);
    clock = T0 + 60_000;

    await createRecovery({ store, reconciler, now: () => clock }).run();

    expect(store.intents.require(MERCHANT, sikFor(1)).state).toBe('CONFIRMED_NOT_APPLIED');
    expect(rail.inspect.refundsForPayment(paymentId)).toHaveLength(0);
  });

  it('recovers a RECONCILING intent whose pass died with its process', async () => {
    await strandInFlight(1, true);
    // A reconciler claimed it, then the process died mid-pass.
    store.intents.transition({
      merchant_id: MERCHANT,
      sik: sikFor(1),
      from: 'IN_FLIGHT',
      to: 'UNKNOWN',
      at: (clock += 1),
    });
    store.intents.transition({
      merchant_id: MERCHANT,
      sik: sikFor(1),
      from: 'UNKNOWN',
      to: 'RECONCILING',
      at: (clock += 1),
      lease: { owner: 'dead-reconciler', expires_at: clock + 30_000 },
    });
    clock += 60_000;

    const report = await createRecovery({ store, reconciler, now: () => clock }).run();
    expect(report.recovered).toBe(1);
    expect(store.intents.require(MERCHANT, sikFor(1)).state).toBe('APPLIED');

    const recoveryRecord = store.audit.read(1, 1000).find((r) => r.kind === RECOVERY_REASON);
    expect(recoveryRecord?.payload).toMatchObject({
      from: 'RECONCILING',
      via: 'RECONCILE_INCONCLUSIVE',
    });
  });

  it('leaves a live lease alone', async () => {
    await strandInFlight(1, true);
    clock = T0 + 1_000; // lease still has 29 seconds

    const report = await createRecovery({ store, reconciler, now: () => clock }).run();
    expect(report.recovered).toBe(0);
    expect(store.intents.require(MERCHANT, sikFor(1)).state).toBe('IN_FLIGHT');
  });

  it('keeps answering 503 while it is still reconciling, counting down', async () => {
    // The gap this closes: reporting ready the instant the scan finishes would
    // let traffic in while recovered intents are still unaccounted for.
    await strandInFlight(1, true);
    await strandInFlight(2, true);
    clock = T0 + 60_000;

    const seen: Readiness[] = [];
    const probe: { readiness?: () => Readiness } = {};
    const observing: Reconciler = {
      reconcile: (intent) => reconciler.reconcile(intent),
      settle: async (intent) => {
        if (probe.readiness !== undefined) seen.push(probe.readiness());
        return reconciler.settle(intent);
      },
    };
    const recovery = createRecovery({ store, reconciler: observing, now: () => clock });
    probe.readiness = () => recovery.readiness();

    await recovery.run();

    expect(seen).toHaveLength(2);
    expect(seen[0]).toEqual({ ready: false, phase: 'reconciling', outstanding: 2, status: 503 });
    expect(seen[1]).toEqual({ ready: false, phase: 'reconciling', outstanding: 1, status: 503 });
    expect(recovery.readiness()).toEqual({
      ready: true,
      phase: 'ready',
      outstanding: 0,
      status: 200,
    });
  });

  it('is ready immediately when there is nothing to recover', async () => {
    const recovery = createRecovery({ store, reconciler, now: () => clock });
    expect(recovery.readiness().status).toBe(503);
    const report = await recovery.run();
    expect(report.recovered).toBe(0);
    expect(recovery.readiness().status).toBe(200);
  });
});

describe('the drift sweep', () => {
  it('flags duplicates: two rail entities carrying one sik', async () => {
    propose(store, intentInput(1));
    // Two refunds stamped with the same sik. Exactly-once has failed and the
    // sweep is how we would find out.
    await rail.createRefund({
      payment_id: paymentId,
      amount_minor: 340_000,
      receipt: sikReceipt(sikFor(1)),
      notes: { interlock_sik: sikFor(1) },
    });
    await rail.createRefund({
      payment_id: paymentId,
      amount_minor: 340_000,
      receipt: `other_${sikFor(1)}`.slice(0, 40),
      notes: { interlock_sik: sikFor(1) },
    });

    const report = await createSweep({ store, rail, now: () => clock }).runOnce();
    expect(report.duplicates).toHaveLength(1);
    expect(report.duplicates[0]?.sik).toBe(sikFor(1));
    expect(report.duplicates[0]?.rail_entity_ids).toEqual([
      'rfnd_MOCK0000000001',
      'rfnd_MOCK0000000002',
    ]);
  });

  it('flags a phantom success: APPLIED with nothing behind it', async () => {
    propose(store, intentInput(1));
    for (const [from, to] of [
      ['PROPOSED', 'AUTHORIZED'],
      ['AUTHORIZED', 'IN_FLIGHT'],
      ['IN_FLIGHT', 'APPLIED'],
    ] as const) {
      store.intents.transition({
        merchant_id: MERCHANT,
        sik: sikFor(1),
        from,
        to,
        at: (clock += 1),
      });
    }

    const report = await createSweep({ store, rail, now: () => clock }).runOnce();
    expect(report.phantoms).toHaveLength(1);
    expect(report.phantoms[0]).toEqual({
      kind: 'PHANTOM_SUCCESS',
      merchant_id: MERCHANT,
      sik: sikFor(1),
      recorded_entity_id: null,
    });
  });

  it('flags an orphan: a rail entity with no intent row', async () => {
    // Stamped, but we never proposed it. Money left by another path.
    await rail.createRefund({
      payment_id: paymentId,
      amount_minor: 340_000,
      receipt: sikReceipt(sikFor(9)),
      notes: { interlock_sik: sikFor(9) },
    });
    // And one with no stamp at all: it never saw the gate.
    await rail.createRefund({
      payment_id: paymentId,
      amount_minor: 120_000,
      receipt: 'manual_dashboard_refund',
      notes: {},
    });

    const report = await createSweep({ store, rail, now: () => clock }).runOnce();
    expect(report.orphans).toHaveLength(2);
    expect(report.orphans.map((o) => o.sik).sort()).toEqual([null, sikFor(9)].sort());
  });

  it('makes no absence claim when the rail walk cannot finish', async () => {
    propose(store, intentInput(1));
    const broken = {
      ...rail,
      listRefunds: () => Promise.reject(new RailUnavailableError('listRefunds', 'partitioned')),
    };

    const report = await createSweep({ store, rail: broken, now: () => clock }).runOnce();
    expect(report.complete).toBe(false);
    expect(report.phantoms).toEqual([]);
    expect(report.orphans).toEqual([]);
    expect(report.duplicates).toEqual([]);
  });

  it('records each finding in the audit chain', async () => {
    await rail.createRefund({
      payment_id: paymentId,
      amount_minor: 340_000,
      receipt: sikReceipt(sikFor(9)),
      notes: { interlock_sik: sikFor(9) },
    });
    const before = store.audit.count();
    await createSweep({ store, rail, now: () => clock }).runOnce();
    expect(store.audit.count()).toBe(before + 1);
    expect(store.audit.head()?.kind).toBe('SWEEP_ORPHAN');
    expect(store.audit.verifyChain()).toBeNull();
  });

  it('reports nothing and writes nothing when the ledger and rail agree', async () => {
    const before = store.audit.count();
    const report = await createSweep({ store, rail, now: () => clock }).runOnce();
    expect(report).toMatchObject({ duplicates: [], phantoms: [], orphans: [], complete: true });
    expect(store.audit.count()).toBe(before);
  });

  it('stops cleanly when started on its interval', () => {
    const stop = createSweep({ store, rail, now: () => clock, intervalMs: 60_000 }).start();
    expect(typeof stop).toBe('function');
    stop();
  });
});
