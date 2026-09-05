import { onUnresolvable, type GateResult } from '@interlock/core';
import type { GateContext } from './ladder.js';
import type { ReferentResolver } from './resolver.js';

/**
 * Gate 2 — value authorisation.
 *
 * Every referent is resolved by us, off our own read-only client, and never
 * taken from the arguments or from anything the model said. See resolver.ts for
 * why that distinction is the whole point.
 *
 * The resolved entities go into the result's evidence, so the decision record
 * holds not just the verdict but the numbers it was reached from — a replay is
 * exact rather than approximate.
 */

const GATE = 'g2_value';

function fail(
  verdict: 'HOLD' | 'BLOCK',
  reason: string,
  message: string,
  evidence: Record<string, unknown>,
): GateResult {
  return { gate: GATE, verdict, reason_code: reason, message, evidence };
}

export function createG2Value(resolver: ReferentResolver): {
  readonly name: string;
  evaluate(context: GateContext): Promise<GateResult>;
} {
  return {
    name: GATE,
    async evaluate({ action, mandate }: GateContext): Promise<GateResult> {
      const grant = mandate.scope.grants[action.tool];
      if (grant === undefined) {
        return fail('BLOCK', 'TOOL_NOT_GRANTED', `${action.tool} is not granted`, {});
      }
      const degraded = onUnresolvable(grant);
      const { value } = grant;

      const payment = await resolver.payment(action.subject);
      if (!payment.ok) {
        return fail('BLOCK' === degraded ? 'BLOCK' : 'HOLD', 'SUBJECT_UNRESOLVABLE',
          `could not resolve payment ${action.subject}: ${payment.reason}`,
          { subject: action.subject, on_unresolvable: degraded, reason: payment.reason });
      }

      const order = payment.value.order_id === null ? null : await resolver.order(payment.value.order_id);
      if (order !== null && !order.ok) {
        return fail(degraded, 'ORDER_UNRESOLVABLE',
          `could not resolve order ${payment.value.order_id ?? ''}: ${order.reason}`,
          { order_id: payment.value.order_id, on_unresolvable: degraded, reason: order.reason });
      }

      const evidence: Record<string, unknown> = {
        resolved_at: payment.fetched_at,
        payment: payment.value,
        order: order === null ? null : order.value,
        constraint: value,
        requested_amount_minor: action.amount_minor,
      };

      if (!value.currencies.includes(action.currency)) {
        return fail('BLOCK', 'CURRENCY_NOT_GRANTED',
          `${action.currency} is not among ${value.currencies.join(', ')}`, evidence);
      }
      if (action.currency !== payment.value.currency) {
        return fail('BLOCK', 'CURRENCY_MISMATCH',
          `payment is in ${payment.value.currency}, not ${action.currency}`, evidence);
      }
      if (action.amount_minor > value.max_amount_minor) {
        return fail('BLOCK', 'AMOUNT_ABOVE_GRANT',
          `${String(action.amount_minor)} exceeds the granted maximum ` +
            `${String(value.max_amount_minor)}`, evidence);
      }
      if (action.amount_minor < value.min_amount_minor) {
        return fail('BLOCK', 'AMOUNT_BELOW_GRANT',
          `${String(action.amount_minor)} is below the granted minimum ` +
            `${String(value.min_amount_minor)}`, evidence);
      }

      const refundable = payment.value.amount_minor - payment.value.amount_refunded_minor;
      if (action.amount_minor > refundable) {
        return fail('BLOCK', 'AMOUNT_ABOVE_REFUNDABLE',
          `${String(action.amount_minor)} exceeds the ${String(refundable)} still refundable ` +
            `on ${payment.value.id}`, evidence);
      }

      // The resolved order is the claim the refund is supposedly against. An
      // agent asking for more than was ever paid is the case this exists for.
      if (order !== null && order.ok && action.amount_minor > order.value.amount_paid_minor) {
        return fail('BLOCK', 'AMOUNT_ABOVE_ORDER',
          `${String(action.amount_minor)} exceeds the ${String(order.value.amount_paid_minor)} ` +
            `paid on order ${order.value.id}`, evidence);
      }

      return {
        gate: GATE,
        verdict: 'ALLOW',
        reason_code: 'WITHIN_GRANT',
        message: `${String(action.amount_minor)} ${action.currency} is within the grant`,
        evidence,
      };
    },
  };
}
