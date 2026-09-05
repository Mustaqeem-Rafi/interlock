import type { GateResult } from '@interlock/core';
import type { Store } from '@interlock/store';
import type { GateContext } from './ladder.js';

/**
 * Gate 3 — ceilings, velocity and the fee budget.
 *
 * Every gate above judges one call alone: in scope (G1), inside the grant (G2),
 * not a duplicate (G4). All three correctly say yes to each member of a
 * sequence whose *sum* is the harm — A-10's four in-limit refunds that together
 * exceed the day's authority, C-07's daily instant settlement that is faultless
 * except for the Rs 32,000 a month in fees nobody approved. Only an accumulator
 * over what has already been applied catches either. Integer arithmetic over
 * rows the ledger already holds: no rates, no floats.
 */

const GATE = 'g3_limits';

function block(reason: string, message: string, evidence: Record<string, unknown>): GateResult {
  return { gate: GATE, verdict: 'BLOCK', reason_code: reason, message, evidence };
}

export function createG3Limits(store: Store): {
  readonly name: string;
  evaluate(context: GateContext): GateResult;
} {
  return {
    name: GATE,
    evaluate({ action, mandate, now }: GateContext): GateResult {
      // Keyed off the *mandate's* merchant, not the request's. Gate 1 blocks a
      // mismatch so the two are one id in the composed ladder, but taking it from
      // the file a human approved means a misordered ladder cannot be handed a
      // foreign merchant_id and be given a fresh, empty ceiling.
      const merchantId = mandate.merchant_id;
      const checked: Record<string, unknown>[] = [];

      for (const velocity of mandate.limits.windows) {
        if (velocity.currency !== action.currency) continue;
        const since = now - velocity.window_ms;

        // No `tool` filter, deliberately: a velocity window is a merchant-wide
        // ceiling. Accumulating per tool would let each granted tool spend the
        // whole allowance separately, which is the loophole A-10 walks through.
        // windowTotals has no currency dimension either, so the sum spans every
        // currency the merchant moved while the ceiling is denominated in one.
        // Amounts are positive, so that can only over-count and never let a call
        // through — but it is why a v0.1 mandate declares windows in one currency.
        const totals = store.intents.windowTotals({ merchant_id: merchantId, since, until: now });
        const projectedCalls = totals.calls + 1;
        const projectedAmount = totals.amount_minor + action.amount_minor;
        const evidence: Record<string, unknown> = {
          window: { ...velocity, since, until: now },
          totals,
          incoming_amount_minor: action.amount_minor,
          projected_calls: projectedCalls,
          projected_amount_minor: projectedAmount,
        };

        if (projectedCalls > velocity.max_calls) {
          return block('VELOCITY_CALLS_EXCEEDED',
            `${String(totals.calls)} + 1 = ${String(projectedCalls)} calls in ` +
              `${String(velocity.window_ms)}ms exceeds the ${String(velocity.max_calls)} allowed`,
            evidence);
        }
        if (projectedAmount > velocity.max_amount_minor) {
          return block('WINDOW_AMOUNT_EXCEEDED',
            `${String(totals.amount_minor)} + ${String(action.amount_minor)} = ` +
              `${String(projectedAmount)} ${action.currency} in ${String(velocity.window_ms)}ms ` +
              `exceeds the ${String(velocity.max_amount_minor)} allowed`, evidence);
        }
        checked.push(evidence);
      }

      const budget = mandate.limits.fee_budgets[action.currency];
      let feeEvidence: Record<string, unknown> | null = null;

      if (budget !== undefined) {
        const since = now - budget.window_ms;
        const totals = store.intents.windowTotals({ merchant_id: merchantId, since, until: now });

        // THE CRUCIAL PART. `fee_minor` is summed off the attempt rows, which
        // carry `fees`/`tax` exactly as the RAIL REPORTED THEM on responses we
        // actually received — never a rate multiplied by an amount. CLAUDE.md
        // forbids hardcoding a fee rate, and this is the gate that would be
        // tempted to, because a forward-looking check wants a number for the call
        // that has not happened yet. So the fee is not projected: we refuse once
        // what was already charged reaches the ceiling — hence `>=` here where the
        // windows use `>` — and this call's own cost is learned from its response
        // into the same sum. Note the unit: a ceiling on COST INCURRED, not on
        // amount moved, the same accumulator over a different column. That is what
        // makes C-07 catchable when scope, value and idempotency all correctly say
        // yes; nothing is wrong with the settlement except what it cost.
        feeEvidence = {
          window: { window_ms: budget.window_ms, since, until: now },
          max_fee_minor: budget.max_fee_minor,
          fee_minor_charged: totals.fee_minor,
          remaining_fee_minor: budget.max_fee_minor - totals.fee_minor,
          applied_calls: totals.calls,
        };

        if (totals.fee_minor >= budget.max_fee_minor) {
          return block('FEE_BUDGET_EXHAUSTED',
            `${String(totals.fee_minor)} ${action.currency} of fees charged in the last ` +
              `${String(budget.window_ms)}ms has reached the ${String(budget.max_fee_minor)} budget`,
            feeEvidence);
        }
      }

      return {
        gate: GATE,
        verdict: 'ALLOW',
        reason_code: 'WITHIN_LIMITS',
        message: `${String(action.amount_minor)} ${action.currency} is inside ` +
          `${String(checked.length)} velocity window(s)` +
          (feeEvidence === null ? '; no fee budget applies' : ' and the fee budget'),
        evidence: { windows: checked, fee_budget: feeEvidence, evaluated_at: now },
      };
    },
  };
}
