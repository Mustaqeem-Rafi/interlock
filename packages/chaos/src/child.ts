import { computeSik, railSubjectId } from '@interlock/core';
import { openStore, type Store } from '@interlock/store';
import {
  createMockRail,
  createReconciler,
  createRecovery,
  createWal,
  nextState,
  propose,
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

export type ChildMode = 'issue' | 'recover';

export interface ChildConfig {
  readonly mode: ChildMode;
  readonly dbPath: string;
  readonly railDir: string;
  readonly merchantId: string;
  readonly paymentId: string;
  readonly amountMinor: number;
  readonly currency: string;
}

export interface ChildResult {
  readonly ok: true;
  readonly mode: ChildMode;
  readonly sik: string;
  readonly state: IntentState | null;
  readonly railEntityId: string | null;
  readonly recovered?: number;
  readonly ready?: boolean;
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
  if (mode !== 'issue' && mode !== 'recover') {
    throw new ChaosConfigError(`INTERLOCK_CHAOS_MODE must be issue or recover, got ${mode}`);
  }
  return {
    mode,
    dbPath: required('INTERLOCK_DB_PATH'),
    railDir: required('INTERLOCK_CHAOS_RAIL_DIR'),
    merchantId: required('INTERLOCK_CHAOS_MERCHANT'),
    paymentId: required('INTERLOCK_CHAOS_PAYMENT'),
    amountMinor: Number.parseInt(required('INTERLOCK_CHAOS_AMOUNT'), 10),
    currency: process.env['INTERLOCK_CHAOS_CURRENCY'] ?? 'INR',
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
    });

    const sik = sikForTrial(config);

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
