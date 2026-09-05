import { InvariantViolation, type IntentState } from '@interlock/core';
import {
  DuplicateIntentError,
  StaleIntentStateError,
  type IntentRow,
  type NewIntent,
  type Store,
} from '@interlock/store';
import { nextState } from './machine.js';

/**
 * Gate 4's entry point.
 *
 * The intent row is created here, inside Gate 4, and not by the ladder — because
 * the SIK depends on the subject id that Gate 2 resolves off the rail, so there
 * is nothing to key a row on until that resolution has happened.
 *
 * The row goes in at PROPOSED, before the remaining gates have finished. That is
 * deliberate: the INSERT is the concurrency control. Two agents racing the same
 * semantic refund both try it, exactly one wins the primary key, and the loser
 * is told what the winner is doing. No lock is taken anywhere, and none is
 * needed — the loser learns the truth by reading the row it failed to create.
 */

export type ProposeDisposition =
  /** This proposal created the intent. Carry on down the ladder. */
  | { readonly kind: 'CREATED' }
  /** A prior attempt ended without applying, and this proposal revives it. */
  | { readonly kind: 'REOPENED'; readonly from: IntentState }
  | { readonly kind: 'HOLD'; readonly reason: 'DUPLICATE_IN_PROGRESS' | 'HELD_AWAITING_HUMAN' }
  | {
      readonly kind: 'BLOCK';
      readonly reason: 'ALREADY_APPLIED' | 'ALREADY_BLOCKED' | 'QUARANTINED';
      /** Present for ALREADY_APPLIED: the entity the first attempt produced. */
      readonly rail_entity_id: string | null;
    };

export interface ProposeResult {
  readonly disposition: ProposeDisposition;
  readonly intent: IntentRow;
}

/** How many times to re-read when another writer moves the row underneath us. */
const MAX_RACES = 3;

function dispositionFor(
  store: Store,
  existing: IntentRow,
  at: number,
): ProposeResult {
  switch (existing.state) {
    // -----------------------------------------------------------------------
    // Something is already happening for this exact meaning. Hold; do not race.
    // -----------------------------------------------------------------------
    case 'PROPOSED':
    case 'AUTHORIZED':
    case 'IN_FLIGHT':
    case 'UNKNOWN':
    case 'RECONCILING':
      return {
        disposition: { kind: 'HOLD', reason: 'DUPLICATE_IN_PROGRESS' },
        intent: existing,
      };

    case 'HELD':
      return {
        disposition: { kind: 'HOLD', reason: 'HELD_AWAITING_HUMAN' },
        intent: existing,
      };

    // -----------------------------------------------------------------------
    // Already decided. Both are absorbing (I4), so there is nothing to reopen.
    // -----------------------------------------------------------------------
    case 'APPLIED':
      // The answer to "refund this again" is the refund we already made. The
      // agent gets the original entity id, not a second movement of money.
      return {
        disposition: {
          kind: 'BLOCK',
          reason: 'ALREADY_APPLIED',
          rail_entity_id: existing.rail_entity_id,
        },
        intent: existing,
      };

    case 'BLOCKED':
      return {
        disposition: { kind: 'BLOCK', reason: 'ALREADY_BLOCKED', rail_entity_id: null },
        intent: existing,
      };

    case 'QUARANTINED':
      return {
        disposition: { kind: 'BLOCK', reason: 'QUARANTINED', rail_entity_id: null },
        intent: existing,
      };

    // -----------------------------------------------------------------------
    // Finished without applying, and we know that positively. Safe to reopen.
    //
    // CONFIRMED_NOT_APPLIED: a reconciliation pass walked the rail to
    // exhaustion and found nothing.
    // FAILED_TERMINAL: the rail refused before acting and told us so.
    //
    // Neither is a guess. UNKNOWN, which *is* a guess, is handled above as a
    // hold and never lands here.
    // -----------------------------------------------------------------------
    case 'CONFIRMED_NOT_APPLIED':
    case 'FAILED_TERMINAL': {
      const event = existing.state === 'FAILED_TERMINAL' ? 'REOPENED' : 'RETRY_AUTHORIZED';
      const reopened = store.intents.transition({
        merchant_id: existing.merchant_id,
        sik: existing.sik,
        from: existing.state,
        to: nextState(existing.state, event),
        at,
        audit_kind: event,
        audit_payload: { attempt_seq: existing.attempt_seq },
      });
      return {
        disposition: { kind: 'REOPENED', from: existing.state },
        intent: reopened,
      };
    }

    default:
      return assertNever(existing.state);
  }
}

function assertNever(state: never): never {
  throw new InvariantViolation(
    'gate4.propose',
    `unhandled intent state ${JSON.stringify(state)}`,
  );
}

/**
 * Create the intent, or explain what the existing one is doing.
 *
 * Never returns two intents for one meaning, and never creates a second row —
 * I1 is upheld by the INSERT failing, not by checking first and then inserting,
 * which would have a window between the check and the write.
 */
export function propose(store: Store, input: NewIntent): ProposeResult {
  for (let race = 0; race < MAX_RACES; race += 1) {
    try {
      return {
        disposition: { kind: 'CREATED' },
        intent: store.intents.create({ ...input, state: 'PROPOSED' }),
      };
    } catch (error) {
      if (!(error instanceof DuplicateIntentError)) throw error;

      const existing = store.intents.require(input.merchant_id, input.sik);
      try {
        return dispositionFor(store, existing, input.at);
      } catch (raced) {
        // Another writer moved the row between our read and our transition.
        // Re-read rather than assume; assuming here is how money moves twice.
        if (!(raced instanceof StaleIntentStateError)) throw raced;
      }
    }
  }

  throw new InvariantViolation(
    'gate4.propose',
    `intent ${input.merchant_id}/${input.sik} changed state ${MAX_RACES} times while proposing`,
  );
}
