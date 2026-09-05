import {
  type AttemptOutcome,
  Currency,
  IntentState,
  MerchantId,
  PositiveMinorAmount,
  ReversibilityClass,
  Sha256Hex,
  Sik,
  ToolName,
  EpochMs,
} from '@interlock/core';
import { z } from 'zod';
import { appendAuditWithin } from './audit.js';
import { inWriteTransaction, type Db } from './db.js';
import {
  DuplicateIntentError,
  IntentNotFoundError,
  StaleIntentStateError,
  StoreConstraintError,
} from './errors.js';

export interface IntentRow {
  readonly merchant_id: string;
  readonly sik: string;
  readonly tool: string;
  readonly subject_id: string;
  readonly amount_minor: number;
  readonly currency: string;
  readonly reversibility: string;
  readonly params_hash: string;
  readonly state: IntentState;
  readonly attempt_seq: number;
  readonly reconcile_attempts: number;
  readonly lease_owner: string | null;
  readonly lease_expires_at: number | null;
  readonly rail_entity_id: string | null;
  readonly mandate_hash: string;
  readonly first_seen_at: number;
  readonly updated_at: number;
}

export interface AttemptRow {
  readonly merchant_id: string;
  readonly sik: string;
  readonly attempt_seq: number;
  readonly started_at: number;
  readonly finished_at: number | null;
  readonly outcome: AttemptOutcome | null;
  readonly rail_entity_id: string | null;
  readonly http_status: number | null;
  readonly fee_minor: number | null;
  readonly tax_minor: number | null;
  readonly error_code: string | null;
  readonly request_json: string;
  readonly response_json: string | null;
}

/** Zod at the boundary: a float amount is rejected here, before it reaches SQL. */
export const NewIntent = z.strictObject({
  merchant_id: MerchantId,
  sik: Sik,
  tool: ToolName,
  subject_id: z.string().min(1),
  amount_minor: PositiveMinorAmount,
  currency: Currency,
  reversibility: ReversibilityClass,
  params_hash: Sha256Hex,
  mandate_hash: Sha256Hex,
  state: IntentState.default('PROPOSED'),
  at: EpochMs,
});
export type NewIntent = z.input<typeof NewIntent>;

export interface TransitionInput {
  readonly merchant_id: string;
  readonly sik: string;
  /** Compare-and-set guard. The update only applies if the row is still here. */
  readonly from: IntentState;
  readonly to: IntentState;
  readonly at: number;
  readonly rail_entity_id?: string | null;
  readonly reconcile_attempts?: number;
  /**
   * Change the lease in the same transaction as the state change. `undefined`
   * leaves it alone, `null` clears it, an object claims it. Two transactions
   * would leave a window where a RECONCILING row carries no lease and is
   * therefore invisible to the recovery sweep forever.
   */
  readonly lease?: { readonly owner: string; readonly expires_at: number } | null;
  readonly audit_kind?: string;
  readonly audit_payload?: Record<string, unknown>;
}

export interface StartAttemptInput {
  readonly merchant_id: string;
  readonly sik: string;
  /** The state the intent must be in for an attempt to begin. */
  readonly from: IntentState;
  readonly at: number;
  readonly request: unknown;
  readonly lease_owner: string;
  readonly lease_ms: number;
}

export interface FinishAttemptInput {
  readonly merchant_id: string;
  readonly sik: string;
  readonly attempt_seq: number;
  readonly at: number;
  readonly outcome: AttemptOutcome;
  readonly rail_entity_id?: string | null;
  readonly http_status?: number | null;
  readonly fee_minor?: number | null;
  readonly tax_minor?: number | null;
  readonly error_code?: string | null;
  readonly response?: unknown;
}

const INTENT_COLUMNS = `merchant_id, sik, tool, subject_id, amount_minor, currency,
  reversibility, params_hash, state, attempt_seq, reconcile_attempts, lease_owner,
  lease_expires_at, rail_entity_id, mandate_hash, first_seen_at, updated_at`;

const ATTEMPT_COLUMNS = `merchant_id, sik, attempt_seq, started_at, finished_at, outcome,
  rail_entity_id, http_status, fee_minor, tax_minor, error_code, request_json, response_json`;

function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    typeof error.code === 'string' &&
    error.code.startsWith('SQLITE_CONSTRAINT_PRIMARYKEY')
  );
}

export interface IntentRepository {
  /** Throws DuplicateIntentError if one already exists — that is I1 doing its job. */
  create(input: NewIntent): IntentRow;
  find(merchantId: string, sik: string): IntentRow | undefined;
  require(merchantId: string, sik: string): IntentRow;
  /** Moves state and appends exactly one audit record, atomically (I6). */
  transition(input: TransitionInput): IntentRow;
  /** Allocates the next attempt_seq (I5) and writes the attempt row before the call. */
  startAttempt(input: StartAttemptInput): { intent: IntentRow; attempt: AttemptRow };
  finishAttempt(input: FinishAttemptInput): AttemptRow;
  attempts(merchantId: string, sik: string): AttemptRow[];
  releaseLease(merchantId: string, sik: string, at: number): IntentRow;
  /**
   * Rows holding a lease that has lapsed. Defaults to IN_FLIGHT; boot recovery
   * also asks for RECONCILING, since a process can die mid-pass.
   */
  sweepExpiredLeases(
    nowMs: number,
    options?: { states?: readonly IntentState[]; limit?: number },
  ): IntentRow[];
  /** Intents by state and recency, for the reconciliation sweep. */
  list(options?: {
    states?: readonly IntentState[];
    updatedSince?: number;
    limit?: number;
  }): IntentRow[];
}

export function createIntentRepository(db: Db): IntentRepository {
  const insert = db.prepare(
    `INSERT INTO intents (${INTENT_COLUMNS})
     VALUES (@merchant_id, @sik, @tool, @subject_id, @amount_minor, @currency,
             @reversibility, @params_hash, @state, 0, 0, NULL, NULL, NULL,
             @mandate_hash, @at, @at)`,
  );
  const selectOne = db.prepare(
    `SELECT ${INTENT_COLUMNS} FROM intents WHERE merchant_id = ? AND sik = ?`,
  );
  const placeholders = (n: number): string => new Array(n).fill('?').join(', ');
  const selectAttempts = db.prepare(
    `SELECT ${ATTEMPT_COLUMNS} FROM intent_attempts
     WHERE merchant_id = ? AND sik = ? ORDER BY attempt_seq ASC`,
  );
  const selectAttempt = db.prepare(
    `SELECT ${ATTEMPT_COLUMNS} FROM intent_attempts
     WHERE merchant_id = ? AND sik = ? AND attempt_seq = ?`,
  );

  const read = (merchantId: string, sik: string): IntentRow | undefined =>
    selectOne.get(merchantId, sik) as IntentRow | undefined;

  const requireRow = (merchantId: string, sik: string): IntentRow => {
    const row = read(merchantId, sik);
    if (row === undefined) throw new IntentNotFoundError(merchantId, sik);
    return row;
  };

  return {
    create(input) {
      const parsed = NewIntent.parse(input);
      return inWriteTransaction(db, () => {
        try {
          insert.run(parsed);
        } catch (error) {
          if (isUniqueViolation(error)) {
            throw new DuplicateIntentError(parsed.merchant_id, parsed.sik);
          }
          throw new StoreConstraintError(error instanceof Error ? error.message : String(error));
        }
        appendAuditWithin(db, {
          kind: 'INTENT_CREATED',
          ts: parsed.at,
          payload: {
            merchant_id: parsed.merchant_id,
            sik: parsed.sik,
            tool: parsed.tool,
            subject_id: parsed.subject_id,
            amount_minor: parsed.amount_minor,
            currency: parsed.currency,
            reversibility: parsed.reversibility,
            params_hash: parsed.params_hash,
            mandate_hash: parsed.mandate_hash,
            state: parsed.state,
          },
        });
        return requireRow(parsed.merchant_id, parsed.sik);
      });
    },

    find: read,
    require: requireRow,

    transition(input) {
      return inWriteTransaction(db, () => {
        const before = requireRow(input.merchant_id, input.sik);
        if (before.state !== input.from) {
          throw new StaleIntentStateError(
            input.merchant_id,
            input.sik,
            input.from,
            before.state,
          );
        }

        const leaseMode =
          input.lease === undefined ? 'keep' : input.lease === null ? 'clear' : 'set';

        db.prepare(
          `UPDATE intents
             SET state = @to,
                 rail_entity_id = COALESCE(@rail_entity_id, rail_entity_id),
                 reconcile_attempts = COALESCE(@reconcile_attempts, reconcile_attempts),
                 lease_owner = CASE @lease_mode
                   WHEN 'set' THEN @lease_owner WHEN 'clear' THEN NULL ELSE lease_owner END,
                 lease_expires_at = CASE @lease_mode
                   WHEN 'set' THEN @lease_expires_at WHEN 'clear' THEN NULL ELSE lease_expires_at END,
                 updated_at = @at
           WHERE merchant_id = @merchant_id AND sik = @sik AND state = @from`,
        ).run({
          merchant_id: input.merchant_id,
          sik: input.sik,
          from: input.from,
          to: input.to,
          at: input.at,
          rail_entity_id: input.rail_entity_id ?? null,
          reconcile_attempts: input.reconcile_attempts ?? null,
          lease_mode: leaseMode,
          lease_owner: input.lease?.owner ?? null,
          lease_expires_at: input.lease?.expires_at ?? null,
        });

        appendAuditWithin(db, {
          kind: input.audit_kind ?? 'STATE_CHANGED',
          ts: input.at,
          payload: {
            merchant_id: input.merchant_id,
            sik: input.sik,
            from: input.from,
            to: input.to,
            ...(input.audit_payload ?? {}),
          },
        });

        return requireRow(input.merchant_id, input.sik);
      });
    },

    startAttempt(input) {
      return inWriteTransaction(db, () => {
        const before = requireRow(input.merchant_id, input.sik);
        if (before.state !== input.from) {
          throw new StaleIntentStateError(input.merchant_id, input.sik, input.from, before.state);
        }

        // I5: strictly monotone. The bump and the insert share one transaction,
        // and the (merchant_id, sik, attempt_seq) primary key is what makes a
        // reused sequence number impossible rather than merely unlikely.
        const attemptSeq = before.attempt_seq + 1;

        db.prepare(
          `UPDATE intents
             SET state = 'IN_FLIGHT',
                 attempt_seq = @attempt_seq,
                 lease_owner = @lease_owner,
                 lease_expires_at = @lease_expires_at,
                 updated_at = @at
           WHERE merchant_id = @merchant_id AND sik = @sik AND state = @from`,
        ).run({
          merchant_id: input.merchant_id,
          sik: input.sik,
          from: input.from,
          attempt_seq: attemptSeq,
          lease_owner: input.lease_owner,
          lease_expires_at: input.at + input.lease_ms,
          at: input.at,
        });

        db.prepare(
          `INSERT INTO intent_attempts
             (merchant_id, sik, attempt_seq, started_at, request_json)
           VALUES (@merchant_id, @sik, @attempt_seq, @at, @request_json)`,
        ).run({
          merchant_id: input.merchant_id,
          sik: input.sik,
          attempt_seq: attemptSeq,
          at: input.at,
          request_json: JSON.stringify(input.request),
        });

        appendAuditWithin(db, {
          kind: 'ATTEMPT_STARTED',
          ts: input.at,
          payload: {
            merchant_id: input.merchant_id,
            sik: input.sik,
            from: input.from,
            to: 'IN_FLIGHT',
            attempt_seq: attemptSeq,
            lease_owner: input.lease_owner,
          },
        });

        return {
          intent: requireRow(input.merchant_id, input.sik),
          attempt: selectAttempt.get(
            input.merchant_id,
            input.sik,
            attemptSeq,
          ) as AttemptRow,
        };
      });
    },

    finishAttempt(input) {
      return inWriteTransaction(db, () => {
        const result = db
          .prepare(
            `UPDATE intent_attempts
               SET finished_at = @at, outcome = @outcome, rail_entity_id = @rail_entity_id,
                   http_status = @http_status, fee_minor = @fee_minor, tax_minor = @tax_minor,
                   error_code = @error_code, response_json = @response_json
             WHERE merchant_id = @merchant_id AND sik = @sik AND attempt_seq = @attempt_seq
               AND finished_at IS NULL`,
          )
          .run({
            merchant_id: input.merchant_id,
            sik: input.sik,
            attempt_seq: input.attempt_seq,
            at: input.at,
            outcome: input.outcome,
            rail_entity_id: input.rail_entity_id ?? null,
            http_status: input.http_status ?? null,
            fee_minor: input.fee_minor ?? null,
            tax_minor: input.tax_minor ?? null,
            error_code: input.error_code ?? null,
            response_json: input.response === undefined ? null : JSON.stringify(input.response),
          });

        if (result.changes === 0) {
          throw new StoreConstraintError(
            `attempt ${input.merchant_id}/${input.sik}#${input.attempt_seq} is missing or already finished`,
          );
        }

        appendAuditWithin(db, {
          kind: 'ATTEMPT_FINISHED',
          ts: input.at,
          payload: {
            merchant_id: input.merchant_id,
            sik: input.sik,
            attempt_seq: input.attempt_seq,
            outcome: input.outcome,
            rail_entity_id: input.rail_entity_id ?? null,
            fee_minor: input.fee_minor ?? null,
            tax_minor: input.tax_minor ?? null,
          },
        });

        return selectAttempt.get(
          input.merchant_id,
          input.sik,
          input.attempt_seq,
        ) as AttemptRow;
      });
    },

    attempts(merchantId, sik) {
      return selectAttempts.all(merchantId, sik) as AttemptRow[];
    },

    releaseLease(merchantId, sik, at) {
      return inWriteTransaction(db, () => {
        db.prepare(
          `UPDATE intents SET lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
           WHERE merchant_id = ? AND sik = ?`,
        ).run(at, merchantId, sik);
        return requireRow(merchantId, sik);
      });
    },

    sweepExpiredLeases(nowMs, options = {}) {
      const states = options.states ?? (['IN_FLIGHT'] as const);
      return db
        .prepare(
          `SELECT ${INTENT_COLUMNS} FROM intents
           WHERE state IN (${placeholders(states.length)})
             AND lease_expires_at IS NOT NULL AND lease_expires_at < ?
           ORDER BY lease_expires_at ASC LIMIT ?`,
        )
        .all(...states, nowMs, options.limit ?? 100) as IntentRow[];
    },

    list(options = {}) {
      const states = options.states ?? IntentState.options;
      return db
        .prepare(
          `SELECT ${INTENT_COLUMNS} FROM intents
           WHERE state IN (${placeholders(states.length)}) AND updated_at >= ?
           ORDER BY updated_at ASC LIMIT ?`,
        )
        .all(...states, options.updatedSince ?? 0, options.limit ?? 1000) as IntentRow[];
    },
  };
}
