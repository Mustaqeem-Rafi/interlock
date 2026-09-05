import { computeSik, railSubjectId } from '@interlock/core';
import { openStore, type Store } from '@interlock/store';
import {
  createMockRail,
  createReconciler,
  createRecovery,
  createWal,
  nextState,
  propose,
  KILL_POINT_ENV,
  type IntentState,
} from '@interlock/gate';
import { ChaosConfigError } from './errors.js';
import { appendEffect, railStateFiles, readRailState } from './rail-state.js';

/**
 * One run of the gate, as a real process the matrix can kill.
 *
 * Two modes, and the split matters: `issue` is the process that dies, `recover`
 * is the one that starts up afterwards. Nothing is shared between them except
 * the SQLite file and the rail's journal — which is the whole point, since those
 * two files are all a restarted process has to work out what happened.
 *
 * The last thing this prints is a single JSON line. If the matrix does not see
 * it, the process died before finishing, which is exactly what it arranged.
 */

export type ChildMode = 'issue' | 'recover' | 'retry';

export interface ChildConfig {
  readonly mode: ChildMode;
  readonly dbPath: string;
  readonly railDir: string;
  readonly merchantId: string;
  readonly paymentId: string;
  readonly amountMinor: number;
  readonly currency: string;
  /** Rail faults for this trial, as JSON. */
  readonly faults: Record<string, unknown>;
  /**
   * Issue an unrelated refund first, so dup_response has a previous response to
   * replay. Without one the fault silently does nothing.
   */
  readonly decoy: boolean;
  /**
   * Reconciler backoff cap, in seconds. The matrix drives this to something
   * small: a partitioned trial would otherwise sleep through 2+4+8+16+32
   * seconds of real backoff per trial, and the ordering is what is under test,
   * not the wall clock.
   */
  readonly backoffCapSeconds: number;
  readonly maxReconcileAttempts: number;
}

export interface ChildResult {
  readonly ok: true;
  readonly mode: ChildMode;
  readonly sik: string;
  readonly state: IntentState | null;
  readonly railEntityId: string | null;
  readonly recovered?: number;
  readonly ready?: boolean;
  readonly disposition?: string;
}

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new ChaosConfigError(`${name} is required`);
  }
  return value;
}

export function configFromEnv(): ChildConfig {
  const mode = required('INTERLOCK_CHAOS_MODE');
  if (mode !== 'issue' && mode !== 'recover' && mode !== 'retry') {
    throw new ChaosConfigError(
      `INTERLOCK_CHAOS_MODE must be issue, recover or retry, got ${mode}`,
    );
  }
  return {
    mode,
    dbPath: required('INTERLOCK_DB_PATH'),
    railDir: required('INTERLOCK_CHAOS_RAIL_DIR'),
    merchantId: required('INTERLOCK_CHAOS_MERCHANT'),
    paymentId: required('INTERLOCK_CHAOS_PAYMENT'),
    amountMinor: Number.parseInt(required('INTERLOCK_CHAOS_AMOUNT'), 10),
    currency: process.env['INTERLOCK_CHAOS_CURRENCY'] ?? 'INR',
    faults: JSON.parse(process.env['INTERLOCK_CHAOS_FAULTS'] ?? '{}') as Record<string, unknown>,
    decoy: process.env['INTERLOCK_CHAOS_DECOY'] === '1',
    backoffCapSeconds: Number.parseInt(process.env['INTERLOCK_CHAOS_BACKOFF_CAP'] ?? '1', 10),
    maxReconcileAttempts: Number.parseInt(process.env['INTERLOCK_CHAOS_MAX_RECON'] ?? '3', 10),
  };
}

/** The same meaning every trial, so the sik is stable across the restart. */
export function sikForTrial(config: ChildConfig): string {
  return computeSik({
    merchant_id: config.merchantId,
    tool: 'create_refund',
    subject: railSubjectId(config.paymentId),
    amount_minor: config.amountMinor,
    currency: config.currency,
  });
}

export async function runChild(config: ChildConfig): Promise<ChildResult> {
  const files = railStateFiles(config.railDir);
  const store: Store = openStore(config.dbPath);

  try {
    const rail = createMockRail({
      faults: config.faults,
      restore: readRailState(files),
      // Durable before the response, and before any kill point downstream of it.
      journal: (event) => {
        appendEffect(files, event);
      },
    });

    const reconciler = createReconciler({
      store,
      rail,
      // Nothing here waits on a wall clock we do not control; the delay only
      // needs to be non-zero to exercise the ordering.
      minDelayMs: 10,
      maxBackoffSeconds: config.backoffCapSeconds,
      maxAttempts: config.maxReconcileAttempts,
    });

    const sik = sikForTrial(config);

    if (config.mode === 'recover' || config.mode === 'retry') {
      // Both restart paths run boot recovery first. `retry` then goes on to do
      // what an agent actually does after a failure: ask for the same refund
      // again. That is the request most likely to produce a second one, and
      // nothing in the base matrix was exercising it.
      if (config.mode === 'retry') {
        await createRecovery({ store, reconciler }).run();
        // Awaited, not returned bare: the finally below closes the store, and
        // returning an unsettled promise from inside a try closes it first.
        return await retryTheSameRefund(store, rail, reconciler, config, sik);
      }
    }

    if (config.mode === 'recover') {
      // Boot recovery, before anything else is allowed to happen.
      const recovery = createRecovery({ store, reconciler });
      const report = await recovery.run();
      const intent = store.intents.find(config.merchantId, sik);
      return {
        ok: true,
        mode: 'recover',
        sik,
        state: intent?.state ?? null,
        railEntityId: intent?.rail_entity_id ?? null,
        recovered: report.recovered,
        ready: recovery.readiness().ready,
      };
    }

    if (config.decoy) {
      // Straight at the rail, not through the gate: this is another merchant's
      // refund as far as we are concerned, and its only job is to be the
      // response that dup_response replays over ours.
      //
      // The kill point is disarmed across it. during_call fires inside
      // createRefund, so an armed decoy would swallow the kill and the trial
      // would test the setup instead of the system.
      const armed = process.env[KILL_POINT_ENV];
      delete process.env[KILL_POINT_ENV];
      try {
        await rail.createRefund({
          payment_id: config.paymentId,
          amount_minor: 11_000,
          receipt: 'ilk_DECOYDECOYDECOYDECOYDECOYDECOY',
          notes: { interlock_sik: 'DECOYDECOYDECOYDECOYDECOYDECOYDE' },
        });
      } finally {
        if (armed !== undefined) process.env[KILL_POINT_ENV] = armed;
      }
    }

    // issue: propose, clear the gates, and put one refund on the wire.
    const proposed = propose(store, {
      merchant_id: config.merchantId,
      sik,
      tool: 'create_refund',
      subject_id: config.paymentId,
      amount_minor: config.amountMinor,
      currency: config.currency,
      reversibility: 'irreversible',
      params_hash: 'c'.repeat(64),
      mandate_hash: 'd'.repeat(64),
      at: Date.now(),
    });

    if (proposed.disposition.kind !== 'CREATED' && proposed.disposition.kind !== 'REOPENED') {
      return {
        ok: true,
        mode: 'issue',
        sik,
        state: proposed.intent.state,
        railEntityId: proposed.intent.rail_entity_id,
      };
    }

    const authorized =
      proposed.intent.state === 'AUTHORIZED'
        ? proposed.intent
        : store.intents.transition({
            merchant_id: config.merchantId,
            sik,
            from: 'PROPOSED',
            to: nextState('PROPOSED', 'GATES_PASSED'),
            at: Date.now(),
            audit_kind: 'GATES_PASSED',
          });

    const wal = createWal({ store, rail });
    const outcome = await wal.issueRefund(authorized);

    return {
      ok: true,
      mode: 'issue',
      sik,
      state: outcome.intent.state,
      railEntityId: outcome.intent.rail_entity_id,
    };
  } finally {
    store.close();
  }
}

/**
 * What an agent does after a failure: ask for the same thing again.
 *
 * The whole point is that this must not produce a second refund. Whether it
 * issues depends on what recovery concluded, and propose is the only thing that
 * decides.
 */
async function retryTheSameRefund(
  store: Store,
  rail: ReturnType<typeof createMockRail>,
  reconciler: ReturnType<typeof createReconciler>,
  config: ChildConfig,
  sik: string,
): Promise<ChildResult> {
  const again = propose(store, {
    merchant_id: config.merchantId,
    sik,
    tool: 'create_refund',
    subject_id: config.paymentId,
    amount_minor: config.amountMinor,
    currency: config.currency,
    reversibility: 'irreversible',
    params_hash: 'c'.repeat(64),
    mandate_hash: 'd'.repeat(64),
    at: Date.now(),
  });

  const disposition = again.disposition.kind;
  let intent = again.intent;

  // A fresh row still has to clear the gates before anything may issue.
  if (intent.state === 'PROPOSED') {
    intent = store.intents.transition({
      merchant_id: intent.merchant_id,
      sik: intent.sik,
      from: 'PROPOSED',
      to: nextState('PROPOSED', 'GATES_PASSED'),
      at: Date.now(),
      audit_kind: 'GATES_PASSED',
    });
  }

  // Only AUTHORIZED may reach the rail, and only propose can put it there.
  if (intent.state === 'AUTHORIZED') {
    const wal = createWal({ store, rail });
    const outcome = await wal.issueRefund(intent);
    intent = outcome.intent;

    // I3: an ambiguous outcome is never retried, it is reconciled — and by the
    // caller, promptly, not by waiting for the next restart.
    if (outcome.kind === 'UNKNOWN') {
      const settled = await reconciler.settle(intent);
      intent = settled.intent;
    }
  }

  return {
    ok: true,
    mode: 'retry',
    sik,
    state: intent.state,
    railEntityId: intent.rail_entity_id,
    disposition,
  };
}

// Entry point. Only the final line is parsed by the matrix.
if (process.argv[1] !== undefined && import.meta.url.endsWith('child.js')) {
  runChild(configFromEnv())
    .then((result) => {
      process.stdout.write(`${JSON.stringify(result)}\n`);
    })
    .catch((error: unknown) => {
      process.stdout.write(
        `${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })}\n`,
      );
      process.exitCode = 1;
    });
}
