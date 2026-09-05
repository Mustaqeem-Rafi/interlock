import type { IntentState } from '@interlock/core';
import type { Store } from '@interlock/store';
import { nextState, type MachineEvent } from '../exactly-once/machine.js';

/**
 * The four things a human can do to an intent.
 *
 * Until this file existed, HOLD_RELEASED and HOLD_REJECTED were edges nothing
 * fired and QUARANTINED had no way out at all — the machine had rooms with no
 * doors. Everything here goes through nextState first, so an operator cannot
 * reach a transition the machine does not already permit; the console is a
 * caller of the state machine, never a second implementation of it.
 *
 * None of these call the rail. Approving a hold grants authority and stops;
 * the agent's next request is what spends it. That keeps the guarantee's one
 * sentence true — the only edge into a rail call is AUTHORIZED to IN_FLIGHT,
 * taken by the engine — and it means a mis-click cannot move money on its own.
 */

export type Operation = 'approve' | 'deny' | 'confirm-applied' | 'confirm-not-applied';

const EVENTS: Readonly<Record<Operation, MachineEvent>> = {
  approve: 'HOLD_RELEASED',
  deny: 'HOLD_REJECTED',
  'confirm-applied': 'OPERATOR_CONFIRMED_APPLIED',
  'confirm-not-applied': 'OPERATOR_CONFIRMED_NOT_APPLIED',
};

export interface OperatorAction {
  readonly merchant_id: string;
  readonly sik: string;
  readonly operation: Operation;
  /** Free text. Required, and written verbatim into the audit log. */
  readonly reason: string;
  /** Who is claiming this. Not authenticated beyond the bearer token; recorded anyway. */
  readonly operator: string;
  /** Required by confirm-applied: the entity the human found on the rail. */
  readonly rail_entity_id?: string | undefined;
  readonly at: number;
}

export class OperatorActionError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
    this.name = 'OperatorActionError';
  }
}

export interface OperatorResult {
  readonly sik: string;
  readonly from: IntentState;
  readonly to: IntentState;
  readonly audit_seq: number;
}

export function applyOperatorAction(store: Store, action: OperatorAction): OperatorResult {
  const reason = action.reason.trim();
  if (reason === '') {
    // A state change with no stated reason is indistinguishable from a mistake
    // when someone reads the log during an incident.
    throw new OperatorActionError(400, 'REASON_REQUIRED', 'reason is required and cannot be empty');
  }

  const intent = store.intents.find(action.merchant_id, action.sik);
  if (intent === undefined) {
    throw new OperatorActionError(404, 'NO_SUCH_INTENT', `no intent ${action.sik}`);
  }

  const event = EVENTS[action.operation];
  let to: IntentState;
  try {
    to = nextState(intent.state, event);
  } catch {
    // The machine refused. Report what it actually is rather than a generic
    // failure: "already APPLIED" is the answer to "why did approve not work".
    throw new OperatorActionError(
      409,
      'ILLEGAL_TRANSITION',
      `an intent in ${intent.state} cannot be ${action.operation}d`,
    );
  }

  // Claiming a refund was applied without saying which one leaves the ledger
  // asserting money moved with nothing to point at. That is worse than the
  // quarantine it replaces.
  if (action.operation === 'confirm-applied') {
    const entity = action.rail_entity_id?.trim();
    if (entity === undefined || entity === '') {
      throw new OperatorActionError(
        400,
        'RAIL_ENTITY_REQUIRED',
        'confirm-applied requires the rail entity id you found',
      );
    }
  }

  const row = store.intents.transition({
    merchant_id: action.merchant_id,
    sik: action.sik,
    from: intent.state,
    to,
    at: action.at,
    // Clear any lease: whatever process held this is long gone.
    lease: null,
    ...(action.operation === 'confirm-applied'
      ? { rail_entity_id: action.rail_entity_id?.trim() ?? null }
      : {}),
    audit_kind: `OPERATOR_${action.operation.toUpperCase().replace(/-/g, '_')}`,
    audit_payload: {
      merchant_id: action.merchant_id,
      sik: action.sik,
      from: intent.state,
      to,
      event,
      operator: action.operator,
      reason,
      ...(action.rail_entity_id === undefined
        ? {}
        : { rail_entity_id: action.rail_entity_id.trim() }),
    },
  });

  const head = store.audit.head();
  return { sik: row.sik, from: intent.state, to: row.state, audit_seq: head?.seq ?? 0 };
}
