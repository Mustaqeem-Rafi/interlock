# ADR-0001 — Identity comes from meaning, not from a token the caller invents

**Status:** accepted · **Date:** 2026-09-03

## Context

Exactly-once needs a name for "the same payment". The usual answer is an
idempotency key supplied by the caller: the client generates a UUID, sends it
with the request, and the rail refuses a second request bearing the same key.

That works when the caller is a program. Our caller is a language model.

A model that has been prompt-injected, or has simply lost its place in a long
conversation, generates a *fresh* UUID for its second attempt — because from
its point of view this is a new decision. A caller-supplied key protects
against the network retrying; it does not protect against the caller retrying.
The failure we exist to prevent is precisely the second kind.

## Decision

Identity is derived from what the action *means*, not from what the caller
calls it:

```
sik = base32(sha256(canonicalJson({
  v: 1, merchant_id, tool, subject,
  amount_minor, currency, extra, window, distinct
}))).slice(0, 32)
```

Two consequences follow, and both are deliberate.

**`subject` is the rail entity id we resolved ourselves.** Never the model's
phrasing, never an id it supplied. "The Kumar refund" is not an identity; it is
a description, and descriptions are what injection attacks are made of. Gate 2
resolves the referent against the rail and the resolved id enters the key.

**`create_refund` has no time window.** Two refunds of the same amount against
the same payment are indistinguishable *by meaning*, so the second one is
refused — even a day later, even if a human meant it. This is the deliberately
inconvenient half of the decision. The escape hatch is an explicit
`interlock_distinct_reason` from the agent, which enters the key and is
recorded verbatim in the audit log, so a genuine second refund is possible but
never accidental and never silent.

## Consequences

A legitimate duplicate now requires a sentence explaining itself. We accept
that cost: on this rail the duplicate refund is the loss mechanism, and a
system that makes the dangerous case require an explanation and the safe case
require nothing has its defaults the right way round.

Base32 here uses the alphabet `A–Z2–7`, which excludes `0`, `1`, `8` and `9`.
Fixtures written as `SIK00001` are not valid keys. This cost us three separate
debugging sessions and is written down so it costs a fourth person nothing.
