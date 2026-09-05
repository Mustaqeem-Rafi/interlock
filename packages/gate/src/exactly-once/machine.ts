import { ABSORBING_STATES, InvariantViolation, type IntentState } from '@interlock/core';

/**
 * The exactly-once state machine.
 *
 * One switch. No state-pattern classes, no registry of handlers, no clever
 * abstraction that has to be reassembled in the reader's head. The transition
 * table below is the specification, and it should be possible to lay it beside
 * CLAUDE.md and check them off against each other line by line.
 *
 * The sentence the whole table exists to make true:
 *
 *   The only edge into a rail call is AUTHORIZED -> IN_FLIGHT, and after the
 *   first attempt the only edge into AUTHORIZED is from CONFIRMED_NOT_APPLIED.
 *
 * Read the table and you can verify the first half by searching for IN_FLIGHT
 * on the right-hand side: it appears exactly once. The second half is qualified
 * in one place, FAILED_TERMINAL -> AUTHORIZED, and the reason that edge is safe
 * is written on it.
 */

export type MachineEvent =
  /** The gate ladder finished. */
  | 'GATES_PASSED'
  | 'GATES_HELD'
  | 'GATES_BLOCKED'
  /** A human resolved a hold. */
  | 'HOLD_RELEASED'
  | 'HOLD_REJECTED'
  /** The write-ahead log committed an IN_FLIGHT row. The rail call follows. */
  | 'ATTEMPT_STARTED'
  /** The rail answered. */
  | 'RAIL_APPLIED'
  | 'RAIL_REJECTED'
  | 'RAIL_AMBIGUOUS'
  /** The recovery sweep found an IN_FLIGHT row whose lease lapsed. */
  | 'LEASE_EXPIRED'
  /** Reconciliation. */
  | 'RECONCILE_STARTED'
  | 'RECONCILE_FOUND_APPLIED'
  | 'RECONCILE_CONFIRMED_ABSENT'
  | 'RECONCILE_INCONCLUSIVE'
  /** The only retry edge. */
  | 'RETRY_AUTHORIZED'
  /** A fresh proposal arrived for an intent that finished without applying. */
  | 'REOPENED'
  | 'QUARANTINE';

export const MACHINE_EVENTS: readonly MachineEvent[] = [
  'GATES_PASSED',
  'GATES_HELD',
  'GATES_BLOCKED',
  'HOLD_RELEASED',
  'HOLD_REJECTED',
  'ATTEMPT_STARTED',
  'RAIL_APPLIED',
  'RAIL_REJECTED',
  'RAIL_AMBIGUOUS',
  'LEASE_EXPIRED',
  'RECONCILE_STARTED',
  'RECONCILE_FOUND_APPLIED',
  'RECONCILE_CONFIRMED_ABSENT',
  'RECONCILE_INCONCLUSIVE',
  'RETRY_AUTHORIZED',
  'REOPENED',
  'QUARANTINE',
];

export class IllegalTransitionError extends InvariantViolation {
  readonly from: IntentState;
  readonly event: MachineEvent;

  constructor(from: IntentState, event: MachineEvent, why: string) {
    super('machine.transition', `${from} --${event}--> is not an edge: ${why}`);
    this.from = from;
    this.event = event;
  }
}

function illegal(from: IntentState, event: MachineEvent, why = 'no such transition'): never {
  throw new IllegalTransitionError(from, event, why);
}

function absorbing(from: IntentState, event: MachineEvent): never {
  illegal(from, event, `${from} is absorbing (I4) and nothing leaves it`);
}

/**
 * The transition table.
 *
 * Every case that is not listed is a throw. That direction is deliberate: a new
 * event silently doing nothing would be a bug that hides, whereas a new event
 * throwing is a bug that announces itself on the first test run.
 */
export function nextState(from: IntentState, event: MachineEvent): IntentState {
  switch (from) {
    // -----------------------------------------------------------------------
    // Before a decision.
    // -----------------------------------------------------------------------
    case 'PROPOSED':
      switch (event) {
        case 'GATES_PASSED':
          return 'AUTHORIZED';
        case 'GATES_HELD':
          return 'HELD';
        case 'GATES_BLOCKED':
          return 'BLOCKED';
        default:
          return illegal(from, event);
      }

    case 'HELD':
      switch (event) {
        case 'HOLD_RELEASED':
          // A human said yes. No rail call has been made, so nothing to reconcile.
          return 'AUTHORIZED';
        case 'HOLD_REJECTED':
          return 'BLOCKED';
        case 'QUARANTINE':
          return 'QUARANTINED';
        default:
          return illegal(from, event);
      }

    case 'BLOCKED':
      // I4.
      return absorbing(from, event);

    // -----------------------------------------------------------------------
    // The rail call. This is the whole guarantee.
    // -----------------------------------------------------------------------
    case 'AUTHORIZED':
      switch (event) {
        case 'ATTEMPT_STARTED':
          // The ONLY edge in this table whose target is IN_FLIGHT, and the WAL
          // only raises it after an IN_FLIGHT row is durable on disk (I2).
          return 'IN_FLIGHT';
        case 'GATES_BLOCKED':
          return 'BLOCKED';
        case 'QUARANTINE':
          return 'QUARANTINED';
        default:
          return illegal(from, event);
      }

    case 'IN_FLIGHT':
      switch (event) {
        case 'RAIL_APPLIED':
          return 'APPLIED';
        case 'RAIL_REJECTED':
          // The rail refused before acting, and said so. Unambiguous.
          return 'FAILED_TERMINAL';
        case 'RAIL_AMBIGUOUS':
          // Timeout, 5xx, or no response at all. I3: this never retries.
          return 'UNKNOWN';
        case 'LEASE_EXPIRED':
          // We crashed mid-attempt. Same epistemic position as a timeout.
          return 'UNKNOWN';
        default:
          return illegal(from, event);
      }

    case 'APPLIED':
      // I4.
      return absorbing(from, event);

    // -----------------------------------------------------------------------
    // After an attempt that did not apply, or that we cannot account for.
    // -----------------------------------------------------------------------
    case 'FAILED_TERMINAL':
      switch (event) {
        case 'REOPENED':
          // Safe because FAILED_TERMINAL is only reachable from RAIL_REJECTED,
          // which is an unambiguous refusal: the rail told us it did nothing
          // before it did nothing. We are not guessing.
          return 'AUTHORIZED';
        case 'QUARANTINE':
          return 'QUARANTINED';
        default:
          return illegal(from, event);
      }

    case 'UNKNOWN':
      switch (event) {
        case 'RECONCILE_STARTED':
          return 'RECONCILING';
        case 'QUARANTINE':
          return 'QUARANTINED';
        default:
          // Note what is absent: there is no edge from UNKNOWN to AUTHORIZED.
          // Not knowing is never grounds for trying again.
          return illegal(from, event);
      }

    case 'RECONCILING':
      switch (event) {
        case 'RECONCILE_FOUND_APPLIED':
          return 'APPLIED';
        case 'RECONCILE_CONFIRMED_ABSENT':
          // Only reachable when the pass ran pagination to exhaustion; the
          // store refuses to record the finding otherwise.
          return 'CONFIRMED_NOT_APPLIED';
        case 'RECONCILE_INCONCLUSIVE':
          return 'UNKNOWN';
        case 'QUARANTINE':
          return 'QUARANTINED';
        default:
          return illegal(from, event);
      }

    case 'CONFIRMED_NOT_APPLIED':
      switch (event) {
        case 'RETRY_AUTHORIZED':
          // The retry edge named in CLAUDE.md, and the only one reachable after
          // an attempt has actually been issued.
          return 'AUTHORIZED';
        case 'REOPENED':
          return 'AUTHORIZED';
        case 'QUARANTINE':
          return 'QUARANTINED';
        default:
          return illegal(from, event);
      }

    case 'QUARANTINED':
      // A human is the correct answer at this scale. Nothing automatic leaves.
      return illegal(from, event, 'QUARANTINED requires a human, not an event');

    default:
      return assertNever(from);
  }
}

function assertNever(state: never): never {
  throw new InvariantViolation(
    'machine.transition',
    `unhandled intent state ${JSON.stringify(state)}`,
  );
}

export function canTransition(from: IntentState, event: MachineEvent): boolean {
  try {
    nextState(from, event);
    return true;
  } catch {
    return false;
  }
}

export function isAbsorbing(state: IntentState): boolean {
  return ABSORBING_STATES.includes(state);
}

/**
 * The guard the write-ahead log calls immediately before it commits an
 * IN_FLIGHT row. Stated separately from the table so that the one place a rail
 * call can begin is greppable.
 */
export function assertMayIssueRailCall(state: IntentState): asserts state is 'AUTHORIZED' {
  if (state !== 'AUTHORIZED') {
    throw new InvariantViolation(
      'machine.rail_call',
      `a rail call may only be issued from AUTHORIZED, not from ${state}`,
    );
  }
}

/** Every legal edge, derived from the table itself. For tests and for docs. */
export function allEdges(
  states: readonly IntentState[],
): readonly { from: IntentState; event: MachineEvent; to: IntentState }[] {
  const edges: { from: IntentState; event: MachineEvent; to: IntentState }[] = [];
  for (const from of states) {
    for (const event of MACHINE_EVENTS) {
      try {
        edges.push({ from, event, to: nextState(from, event) });
      } catch {
        // Not an edge.
      }
    }
  }
  return edges;
}
