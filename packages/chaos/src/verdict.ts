import type { IntentState } from '@interlock/gate';
import { KILL_POINTS, type KillPoint } from '@interlock/gate';

/**
 * What the matrix actually asserts.
 *
 * The guarantee is **never two, and never unknown**. It is emphatically not
 * "always one": killing the gate before it writes anything, or inside the
 * request before the rail acts, correctly ends with no refund at all. A matrix
 * that demanded one refund per trial would be asserting the wrong thing and
 * would fail on two of the five kill points for entirely correct behaviour.
 *
 * So a trial passes when all four of these hold after the restart:
 *
 *   1. At most one rail entity carries the sik.        (never two)
 *   2. The intent is in a state we can act on.         (never unknown)
 *   3. If money moved, the ledger says APPLIED.        (no silent loss)
 *   4. If the ledger says APPLIED, money moved.        (no phantom success)
 */

/** States that mean the system has stopped needing to ask the rail anything. */
const RESOLVED: readonly IntentState[] = [
  'APPLIED',
  'CONFIRMED_NOT_APPLIED',
  'FAILED_TERMINAL',
  'BLOCKED',
  'QUARANTINED',
  // Nothing was ever attempted from these two, so there is nothing outstanding.
  'PROPOSED',
  'AUTHORIZED',
  'HELD',
];

/** States that mean a rail call is still unaccounted for. */
const UNRESOLVED: readonly IntentState[] = ['IN_FLIGHT', 'UNKNOWN', 'RECONCILING'];

export const GUARANTEE = 'never two, and never unknown';

export type TrialPhase = 'recover' | 'retry';

/** A named rail fault profile crossed with each kill point. */
export interface FaultProfile {
  readonly name: string;
  readonly faults: Record<string, unknown>;
  /** dup_response needs a previous response to replay. */
  readonly decoy: boolean;
  /**
   * Kill points this fault makes unreachable, by throwing before they run. The
   * process surviving there is correct behaviour, not a disarmed matrix.
   */
  readonly preempts: readonly KillPoint[];
}

export const FAULT_PROFILES: readonly FaultProfile[] = [
  { name: 'none', faults: {}, decoy: false, preempts: [] },
  {
    // Throws inside the call, so nothing after it runs.
    name: 'ambiguous_504',
    faults: { ambiguous_504: {} },
    decoy: false,
    preempts: ['after_call_before_commit', 'after_commit_before_ack'],
  },
  {
    name: 'slow',
    faults: { slow: { delay_ms: 25 } },
    decoy: false,
    preempts: [],
  },
  {
    // The response is rejected between the call and the commit, so only the
    // post-commit kill point becomes unreachable.
    name: 'dup_response',
    faults: { dup_response: { on_calls: [2] } },
    decoy: true,
    preempts: ['after_commit_before_ack'],
  },
  {
    name: 'partition',
    faults: { partition: { from_ms: 0, for_ms: 4_000_000_000_000 } },
    decoy: false,
    preempts: [],
  },
];

export type ViolationKind =
  | 'DOUBLE_APPLIED'
  | 'UNRESOLVED_AFTER_RECOVERY'
  | 'SILENT_LOSS'
  | 'PHANTOM_SUCCESS'
  /** Not a failure of the system — a failure of the test to test anything. */
  | 'KILL_DID_NOT_FIRE'
  /** The ledger points at a rail entity that is not ours. */
  | 'WRONG_ENTITY_RECORDED'
  /** Nothing outstanding, nothing applied, and no way for the agent to proceed. */
  | 'STUCK_NO_PROGRESS';

export interface Violation {
  readonly kind: ViolationKind;
  readonly message: string;
}

export interface TrialObservation {
  readonly killPoint: KillPoint;
  readonly profile: string;
  readonly phase: TrialPhase;
  readonly trial: number;
  readonly sik: string;
  readonly railEntities: readonly string[];
  readonly state: IntentState | null;
  /** What the ledger says the rail entity is. Must be one of ours, or null. */
  readonly recordedEntityId: string | null;
  readonly recovered: number;
  readonly ready: boolean;
  readonly killed: boolean;
  /** False when the fault preempts the kill point, so surviving is correct. */
  readonly killExpected: boolean;
  readonly disposition: string | null;
}

/** What each kill point is expected to end at, for the results table. */
export const EXPECTATION: Readonly<Record<KillPoint, string>> = {
  before_wal: '0 refunds, nothing attempted',
  after_wal_before_call: '0 refunds, CONFIRMED_NOT_APPLIED',
  during_call: '0 refunds, CONFIRMED_NOT_APPLIED',
  after_call_before_commit: '1 refund, APPLIED',
  after_commit_before_ack: '1 refund, APPLIED',
};

export function judge(observation: TrialObservation): readonly Violation[] {
  const violations: Violation[] = [];
  const count = observation.railEntities.length;
  const state = observation.state;
  const where = `${observation.killPoint} trial ${String(observation.trial)}`;

  // Checked first and treated as a violation rather than a warning. If the
  // SIGKILL silently failed to land, the process would finish normally, the
  // refund would apply, recovery would find nothing to do, and every other
  // assertion below would pass — a green matrix that exercised nothing. The two
  // late kill points are indistinguishable from an unkilled run by end state
  // alone, so this is the only thing standing between them and vacuity.
  if (observation.killExpected && !observation.killed) {
    violations.push({
      kind: 'KILL_DID_NOT_FIRE',
      message:
        `${where}: the gate process ran to completion instead of being killed at ` +
        `${observation.killPoint}. This trial proves nothing; the matrix is not ` +
        `measuring what it claims to.`,
    });
  }

  if (count > 1) {
    violations.push({
      kind: 'DOUBLE_APPLIED',
      message:
        `${where}: ${String(count)} rail entities carry sik ${observation.sik} ` +
        `(${observation.railEntities.join(', ')}). The guarantee is "${GUARANTEE}", ` +
        `not "always one" — but two is the failure it exists to prevent.`,
    });
  }

  if (state === null) {
    if (count > 0) {
      violations.push({
        kind: 'SILENT_LOSS',
        message:
          `${where}: ${String(count)} rail entities exist but no intent row does. ` +
          `Money moved and the ledger has no record of it. Guarantee: "${GUARANTEE}".`,
      });
    }
  } else {
    if (UNRESOLVED.includes(state)) {
      violations.push({
        kind: 'UNRESOLVED_AFTER_RECOVERY',
        message:
          `${where}: intent is ${state} after boot recovery finished. ` +
          `Guarantee: "${GUARANTEE}" — this is the "unknown" half, and it means ` +
          `recovery reported ready while a rail call was still unaccounted for.`,
      });
    } else if (!RESOLVED.includes(state)) {
      violations.push({
        kind: 'UNRESOLVED_AFTER_RECOVERY',
        message: `${where}: intent is in unrecognised state ${state}. Guarantee: "${GUARANTEE}".`,
      });
    }

    // QUARANTINED is deliberately exempt. Money moved and we cannot confirm it,
    // but we have stopped and asked for a human rather than guessing — which
    // CLAUDE.md names as the correct answer at this scale. That is escalated,
    // not silent, and the audit chain carries the evidence.
    if (count === 1 && state !== 'APPLIED' && state !== 'QUARANTINED') {
      violations.push({
        kind: 'SILENT_LOSS',
        message:
          `${where}: one rail entity exists but the intent is ${state}. ` +
          `Money moved and the ledger disagrees. Guarantee: "${GUARANTEE}".`,
      });
    }

    // The ledger must not point at somebody else's refund. dup_response exists
    // to produce exactly this, and trusting a returned id is how it lands.
    if (
      observation.recordedEntityId !== null &&
      !observation.railEntities.includes(observation.recordedEntityId)
    ) {
      violations.push({
        kind: 'WRONG_ENTITY_RECORDED',
        message:
          `${where}: the ledger records rail entity ${observation.recordedEntityId}, ` +
          `which does not carry sik ${observation.sik} ` +
          `(ours: ${observation.railEntities.join(', ') || 'none'}). ` +
          `A returned id was trusted without checking the stamp on it.`,
      });
    }

    // Only meaningful after a retry: the agent has asked again and still cannot
    // get anywhere. Not a safety failure, but the refund never happens and
    // nobody is told.
    if (
      observation.phase === 'retry' &&
      count === 0 &&
      (state === 'AUTHORIZED' || state === 'PROPOSED')
    ) {
      violations.push({
        kind: 'STUCK_NO_PROGRESS',
        message:
          `${where}: after a retry the intent is still ${state} with no refund and ` +
          `disposition ${observation.disposition ?? 'none'}. The agent cannot make ` +
          `progress and no human has been asked to.`,
      });
    }

    if (count === 0 && state === 'APPLIED') {
      violations.push({
        kind: 'PHANTOM_SUCCESS',
        message:
          `${where}: the intent is APPLIED but no rail entity carries sik ${observation.sik}. ` +
          `The ledger claims money moved when it did not. Guarantee: "${GUARANTEE}".`,
      });
    }
  }

  return violations;
}

export { KILL_POINTS };
export type { KillPoint };
