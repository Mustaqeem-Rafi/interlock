import {
  GateResult,
  InvariantViolation,
  type AdvisoryVerdict,
  type GateVerdict,
  type Mandate,
  type ProposedAction,
} from '@interlock/core';

/**
 * The verdict ladder.
 *
 * A lattice with one direction of travel. Ranks are BLOCK < HOLD < ALLOW, the
 * combining operation is the floor, and BLOCK absorbs. Running the ladder can
 * only ever lower the verdict, never raise it, so no gate can undo another
 * gate's refusal by being more permissive afterwards.
 *
 * The asymmetry between deterministic gates and model gates is expressed in the
 * type system rather than in a prompt or a comment:
 *
 *   DeterministicGate returns GateVerdict  — 'ALLOW' | 'HOLD' | 'BLOCK'
 *   ModelGate         returns AdvisoryVerdict — 'HOLD' | 'BLOCK'
 *
 * ALLOW is simply not in the model gate's union. A model gate cannot express an
 * upgrade, because there is no value it could return that means one. That is a
 * type, not a policy, and it holds before any code runs. The runtime check below
 * exists anyway, because the type only binds callers that are compiled against
 * it, and a JavaScript caller is not.
 */

export const RANK: Readonly<Record<GateVerdict, number>> = {
  BLOCK: 0,
  HOLD: 1,
  ALLOW: 2,
};

export function rankOf(verdict: GateVerdict): number {
  return RANK[verdict];
}

/** The lattice meet: the more restrictive of two verdicts. */
export function floor(a: GateVerdict, b: GateVerdict): GateVerdict {
  return RANK[b] < RANK[a] ? b : a;
}

/**
 * Refuse to move to a less restrictive verdict.
 *
 * Nothing in the ladder itself can trip this, because the fold only ever takes
 * floors. It is here for anyone who later reaches for the running verdict and
 * tries to set it directly.
 */
export function assertNoUpgrade(from: GateVerdict, to: GateVerdict): void {
  if (RANK[to] > RANK[from]) {
    throw new InvariantViolation(
      'ladder.monotone',
      `attempted to upgrade ${from} to ${to}; the ladder only travels downward`,
    );
  }
}

export interface GateContext {
  readonly action: ProposedAction;
  readonly mandate: Mandate;
  readonly now: number;
}

export interface DeterministicGate {
  readonly name: string;
  evaluate(context: GateContext): GateResult | Promise<GateResult>;
}

/** What a model gate is allowed to say. Note the absence of ALLOW. */
export interface ModelVerdict {
  readonly verdict: AdvisoryVerdict;
  readonly reason_code: string;
  readonly message?: string;
  readonly evidence?: Record<string, unknown>;
}

/**
 * An advisory gate backed by a model. Opt-in, off by default, and incapable of
 * widening what the deterministic gates already decided.
 */
export interface ModelGate {
  readonly name: string;
  evaluate(context: GateContext): Promise<ModelVerdict>;
}

export interface LadderOutcome {
  readonly verdict: GateVerdict;
  readonly results: readonly GateResult[];
}

export interface LadderInput {
  readonly gates: readonly DeterministicGate[];
  /** Empty unless --purpose-check is on. */
  readonly modelGates?: readonly ModelGate[];
  readonly context: GateContext;
}

/**
 * Run the ladder.
 *
 * Stops at the first BLOCK: it is absorbing, so nothing later can change the
 * answer, and continuing would mean doing more work — including rail reads —
 * on a call that has already been refused.
 */
export async function runLadder(input: LadderInput): Promise<LadderOutcome> {
  const results: GateResult[] = [];
  let verdict: GateVerdict = 'ALLOW';

  for (const gate of input.gates) {
    const result = GateResult.parse(await gate.evaluate(input.context));
    results.push(result);
    const next = floor(verdict, result.verdict);
    assertNoUpgrade(verdict, next);
    verdict = next;
    if (verdict === 'BLOCK') return { verdict, results };
  }

  for (const gate of input.modelGates ?? []) {
    const advisory = await gate.evaluate(input.context);

    // The type says this cannot happen. Untyped callers exist.
    if ((advisory.verdict as GateVerdict) === 'ALLOW') {
      throw new InvariantViolation(
        'ladder.model_upgrade',
        `model gate ${gate.name} returned ALLOW; an advisory gate cannot widen a decision`,
      );
    }

    const result = GateResult.parse({
      gate: gate.name,
      verdict: advisory.verdict,
      reason_code: advisory.reason_code,
      message: advisory.message ?? '',
      evidence: { ...advisory.evidence, advisory: true },
    });
    results.push(result);
    const next = floor(verdict, result.verdict);
    assertNoUpgrade(verdict, next);
    verdict = next;
    if (verdict === 'BLOCK') return { verdict, results };
  }

  return { verdict, results };
}

/** The verdict a set of already-computed results implies. */
export function verdictOf(results: readonly GateResult[]): GateVerdict {
  return results.reduce<GateVerdict>((acc, result) => floor(acc, result.verdict), 'ALLOW');
}
