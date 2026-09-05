import { InvariantViolation, type GateResult, type GateVerdict, type Mandate } from '@interlock/core';
import { describe, expect, it } from 'vitest';
import {
  RANK,
  assertNoUpgrade,
  floor,
  runLadder,
  verdictOf,
  type DeterministicGate,
  type GateContext,
  type ModelGate,
} from './ladder.js';

const VERDICTS: readonly GateVerdict[] = ['BLOCK', 'HOLD', 'ALLOW'];

const CONTEXT = {
  action: { tool: 'create_refund' },
  mandate: {} as Mandate,
  now: 1_757_000_000_000,
} as unknown as GateContext;

function stub(name: string, verdict: GateVerdict): DeterministicGate {
  return {
    name,
    evaluate: (): GateResult => ({
      gate: name,
      verdict,
      reason_code: 'STUB',
      message: '',
      evidence: {},
    }),
  };
}

/** Deterministic pseudo-random, so a failure is reproducible from the seed. */
function makeRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

describe('the lattice', () => {
  it('ranks BLOCK below HOLD below ALLOW', () => {
    expect(RANK.BLOCK).toBeLessThan(RANK.HOLD);
    expect(RANK.HOLD).toBeLessThan(RANK.ALLOW);
  });

  it('takes the more restrictive of any two verdicts', () => {
    expect(floor('ALLOW', 'HOLD')).toBe('HOLD');
    expect(floor('HOLD', 'ALLOW')).toBe('HOLD');
    expect(floor('HOLD', 'BLOCK')).toBe('BLOCK');
    expect(floor('BLOCK', 'ALLOW')).toBe('BLOCK');
    for (const v of VERDICTS) expect(floor(v, v)).toBe(v);
  });

  it('refuses an upgrade outright', () => {
    expect(() => {
      assertNoUpgrade('BLOCK', 'ALLOW');
    }).toThrow(InvariantViolation);
    expect(() => {
      assertNoUpgrade('HOLD', 'ALLOW');
    }).toThrow(/only travels downward/);
    expect(() => {
      assertNoUpgrade('ALLOW', 'HOLD');
    }).not.toThrow();
  });
});

describe('property: the ladder never returns a verdict higher than any single result', () => {
  it('holds over 10,000 random gate sequences', async () => {
    const random = makeRandom(20_250_905);
    let checked = 0;

    for (let trial = 0; trial < 10_000; trial += 1) {
      const count = 1 + Math.floor(random() * 6);
      const verdicts: GateVerdict[] = [];
      for (let i = 0; i < count; i += 1) {
        verdicts.push(VERDICTS[Math.floor(random() * VERDICTS.length)] ?? 'ALLOW');
      }

      const outcome = await runLadder({
        gates: verdicts.map((verdict, i) => stub(`g${String(i)}`, verdict)),
        context: CONTEXT,
      });

      // The property: the final verdict is no higher-ranked than any input.
      for (const verdict of verdicts) {
        expect(RANK[outcome.verdict]).toBeLessThanOrEqual(RANK[verdict]);
      }

      // And it is exactly the floor of everything the ladder actually saw,
      // which is a prefix of the inputs because BLOCK stops the walk.
      const seen = outcome.results.map((result) => result.verdict);
      expect(outcome.verdict).toBe(verdictOf(outcome.results));
      expect(RANK[outcome.verdict]).toBe(Math.min(...seen.map((v) => RANK[v])));

      // BLOCK is absorbing: nothing runs after it.
      const firstBlock = verdicts.indexOf('BLOCK');
      if (firstBlock !== -1) {
        expect(outcome.verdict).toBe('BLOCK');
        expect(outcome.results).toHaveLength(firstBlock + 1);
      } else {
        expect(outcome.results).toHaveLength(verdicts.length);
      }
      checked += 1;
    }

    expect(checked).toBe(10_000);
  }, 60_000);
});

describe('model gates cannot widen a decision', () => {
  it('has no ALLOW in its verdict union, so an upgrade is unrepresentable', () => {
    // This is the real guarantee and it is a compile-time one. The line below
    // does not typecheck, which is the point:
    //   const bad: ModelVerdict = { verdict: 'ALLOW', reason_code: 'X' };
    const advisory: ModelGate = {
      name: 'g5_purpose',
      evaluate: () => Promise.resolve({ verdict: 'HOLD', reason_code: 'UNCLEAR_PURPOSE' }),
    };
    expect(advisory.name).toBe('g5_purpose');
  });

  it('throws InvariantViolation if an untyped caller returns ALLOW anyway', async () => {
    const rogue = {
      name: 'g5_purpose',
      evaluate: () => Promise.resolve({ verdict: 'ALLOW', reason_code: 'LOOKS_FINE' }),
    } as unknown as ModelGate;

    await expect(
      runLadder({ gates: [stub('g1', 'ALLOW')], modelGates: [rogue], context: CONTEXT }),
    ).rejects.toThrow(/cannot widen a decision/);
  });

  it('can still downgrade', async () => {
    const advisory: ModelGate = {
      name: 'g5_purpose',
      evaluate: () => Promise.resolve({ verdict: 'HOLD', reason_code: 'UNCLEAR_PURPOSE' }),
    };
    const outcome = await runLadder({
      gates: [stub('g1', 'ALLOW'), stub('g2', 'ALLOW')],
      modelGates: [advisory],
      context: CONTEXT,
    });
    expect(outcome.verdict).toBe('HOLD');
    expect(outcome.results.at(-1)?.evidence['advisory']).toBe(true);
  });

  it('never runs when the deterministic gates already blocked', async () => {
    let ran = false;
    const advisory: ModelGate = {
      name: 'g5_purpose',
      evaluate: () => {
        ran = true;
        return Promise.resolve({ verdict: 'HOLD' as const, reason_code: 'X' });
      },
    };
    const outcome = await runLadder({
      gates: [stub('g1', 'BLOCK')],
      modelGates: [advisory],
      context: CONTEXT,
    });
    expect(outcome.verdict).toBe('BLOCK');
    expect(ran).toBe(false);
  });
});
