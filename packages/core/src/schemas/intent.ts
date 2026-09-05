import { z } from 'zod';

/**
 * The intent lifecycle.
 *
 * The one guarantee everything serves: the only edge into a rail call is
 * AUTHORIZED -> IN_FLIGHT, and after the first attempt the only edge into
 * AUTHORIZED is from CONFIRMED_NOT_APPLIED.
 *
 * The edges themselves live in the gate's machine, not here and not in the
 * store — this is only the vocabulary all three share.
 *
 *  - PROPOSED              row exists, no decision taken yet. Inserted before
 *                          the gates finish, so the primary key is what rejects
 *                          a concurrent duplicate.
 *  - HELD                  a gate returned HOLD; a human has to move it.
 *  - BLOCKED               a gate returned BLOCK. Absorbing (I4).
 *  - AUTHORIZED            cleared. The only state a rail call may leave from.
 *  - IN_FLIGHT             a durable row is on disk and a rail call is outstanding (I2).
 *  - APPLIED               the effect is confirmed on the rail. Absorbing (I4).
 *  - FAILED_TERMINAL       the rail refused, unambiguously, without applying
 *                          anything. Safe to reopen because we were told so.
 *  - UNKNOWN               an attempt ended ambiguously. We do not know whether
 *                          the money moved. Never retry from here (I3).
 *  - RECONCILING           a reconciliation pass is running against the rail.
 *  - CONFIRMED_NOT_APPLIED a pass ran pagination to exhaustion and found
 *                          nothing. The only state a retry may leave from (I3).
 *  - QUARANTINED           we stopped trying. A human is the correct answer.
 */
export const IntentState = z.enum([
  'PROPOSED',
  'HELD',
  'BLOCKED',
  'AUTHORIZED',
  'IN_FLIGHT',
  'APPLIED',
  'FAILED_TERMINAL',
  'UNKNOWN',
  'RECONCILING',
  'CONFIRMED_NOT_APPLIED',
  'QUARANTINED',
]);
export type IntentState = z.infer<typeof IntentState>;

/** I4: nothing leaves these, ever. */
export const ABSORBING_STATES: readonly IntentState[] = ['APPLIED', 'BLOCKED'];

/** How a single rail attempt ended, from our side of the wire. */
export const AttemptOutcome = z.enum([
  'APPLIED',
  /** The rail refused before acting. Unambiguous. */
  'FAILED',
  /** No response arrived. Says nothing about whether the effect landed. */
  'TIMEOUT',
  /** A response arrived but does not settle whether the effect landed. */
  'AMBIGUOUS',
]);
export type AttemptOutcome = z.infer<typeof AttemptOutcome>;

/**
 * What one reconciliation pass concluded.
 *
 * CONFIRMED_NOT_APPLIED is the only conclusion that permits a retry, and it is
 * reachable only when pagination ran to exhaustion in that pass. Everything else
 * is STILL_UNKNOWN, which leaves the intent sitting in the UNKNOWN state.
 */
export const ReconOutcome = z.enum(['APPLIED', 'CONFIRMED_NOT_APPLIED', 'STILL_UNKNOWN']);
export type ReconOutcome = z.infer<typeof ReconOutcome>;
