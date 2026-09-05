# ADR-0005 — The purpose gate is opt-in, advisory, and cannot say yes

**Status:** accepted · **Date:** 2026-09-04

## Context

The obvious thing to build, when the attacker is a prompt injection, is a model
that reads the request and decides whether it looks legitimate. Gate 5 is where
that would go. It is not in v0.1, and the reason is not that there was no time.

Interlock's claim is that **the money path is deterministic**. That claim is
worth more than the marginal recall a purpose judge would add, and the two are
not compatible by default. A model in the decision path is a component whose
failure mode is *being convinced* — which is the same failure mode as the agent
it is supposed to be protecting us from, running on the same kind of input, and
frequently on the same model family. Two components that fail for the same
reason are one component.

There is also an honesty problem. A purpose judge cannot be meaningfully
measured in a weekend. Reporting a false-allow rate from thirty scenarios we
wrote ourselves would be reporting how well it does on our own imagination.

## Decision

Gate 5 is **not implemented** in v0.1. The `--purpose-check` flag exists and
says so, which is how the default stays visibly "off" rather than merely absent.

What *is* implemented is the type that would make it safe:

```ts
export type AdvisoryVerdict = 'HOLD' | 'BLOCK';   // ALLOW is not in the union

export interface ModelGate {
  evaluate(context: GateContext): Promise<{ verdict: AdvisoryVerdict; reason_code: string }>;
}
```

A model gate **cannot express an upgrade**. Not "must not" — *cannot*, because
there is no value it could return that means one. The strongest thing a
convinced model can do is fail to object, and failing to object leaves the
deterministic verdict exactly where it was.

Belt and braces, because a type only binds callers compiled against it: the
ladder is a floor/meet over `BLOCK < HOLD < ALLOW` with `BLOCK` absorbing, and
it throws `InvariantViolation` on any attempted upgrade at runtime. A property
test over 10,000 random gate sequences asserts the final verdict is never
ranked higher than any individual result.

## Consequences

Attacks that are *semantically* wrong but *within* the mandate — a refund to
the right payment, for the right amount, that nonetheless should not happen —
are not caught. That is a real gap and it is stated in the README's operating
envelope rather than papered over.

In exchange, the sentence "no model is consulted at decision time" is a fact
about the artifact and not a claim about our intentions. It is enforced three
ways: no gate imports a model client; `interlock init` — the one command that
does talk to a model — is a separate binary; and the package build greps the
shipped bytes of that binary for the ledger driver, its pragmas and the WAL's
stamp, and refuses to publish if the authoring binary carries any of them.

The model writes the policy. A human approves it. Only deterministic code reads
it afterwards. There is no `--yes`.
