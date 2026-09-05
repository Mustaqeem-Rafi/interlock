import type { GateResult } from '@interlock/core';
import type { GateContext } from './ladder.js';

/**
 * Gate 1 — scope.
 *
 * Three questions, none of which need the rail: is this mandate still in force,
 * is it this agent's mandate, and does it grant this tool at all. Everything
 * here is a comparison against a file a human approved; nothing is inferred and
 * nothing is read from the call's own arguments.
 *
 * A tool absent from `scope.grants` is out of scope, full stop. The proxy also
 * strips ungranted tools from tools/list so the agent never sees them, but that
 * is a usability measure and this is the enforcement — an agent that learned a
 * tool name from somewhere else still cannot reach it.
 */

const GATE = 'g1_scope';

function block(reason: string, message: string, evidence: Record<string, unknown>): GateResult {
  return { gate: GATE, verdict: 'BLOCK', reason_code: reason, message, evidence };
}

export function g1Scope(context: GateContext): GateResult {
  const { action, mandate, now } = context;

  if (action.merchant_id !== mandate.merchant_id) {
    return block(
      'MERCHANT_MISMATCH',
      `this mandate covers ${mandate.merchant_id}, not ${action.merchant_id}`,
      { expected: mandate.merchant_id, actual: action.merchant_id },
    );
  }

  if (action.agent_id !== mandate.agent_id) {
    return block(
      'AGENT_NOT_AUTHORISED',
      `mandate ${mandate.mandate_id} authorises ${mandate.agent_id}, not ${action.agent_id}`,
      { expected: mandate.agent_id, actual: action.agent_id },
    );
  }

  if (now < mandate.issued_at) {
    return block('MANDATE_NOT_YET_VALID', `mandate ${mandate.mandate_id} is not in force yet`, {
      issued_at: mandate.issued_at,
      now,
    });
  }

  if (now >= mandate.expires_at) {
    return block('MANDATE_EXPIRED', `mandate ${mandate.mandate_id} expired`, {
      expires_at: mandate.expires_at,
      now,
      expired_by_ms: now - mandate.expires_at,
    });
  }

  const grant = mandate.scope.grants[action.tool];
  if (grant === undefined) {
    return block('TOOL_NOT_GRANTED', `mandate ${mandate.mandate_id} does not grant ${action.tool}`, {
      tool: action.tool,
      granted: Object.keys(mandate.scope.grants),
    });
  }

  return {
    gate: GATE,
    verdict: 'ALLOW',
    reason_code: 'IN_SCOPE',
    message: `${action.tool} is granted by ${mandate.mandate_id}`,
    evidence: {
      mandate_id: mandate.mandate_id,
      tool: action.tool,
      reversibility: grant.reversibility,
      expires_in_ms: mandate.expires_at - now,
    },
  };
}

export const G1_SCOPE: { readonly name: string; evaluate(c: GateContext): GateResult } = {
  name: GATE,
  evaluate: g1Scope,
};
