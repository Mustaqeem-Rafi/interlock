# ADR-0003 — The reconciler may only claim absence it has actually established

**Status:** accepted · **Date:** 2026-09-03

## Context

When a rail call ends ambiguously — a timeout, a 502, a connection reset — the
money may or may not have moved. The intent goes to `UNKNOWN` and something has
to find out which. That is the reconciler, and it is the most dangerous code in
the system: every wrong answer it gives is a double refund.

It is dangerous in an asymmetric way. Reporting "applied" when nothing was
applied strands a customer and someone complains. Reporting "not applied" when
something *was* applied causes a retry, and the second refund is real money
that nobody complains about until the books are closed.

## Decision

`CONFIRMED_NOT_APPLIED` is the only state that authorises a retry, and it is
reachable only from evidence, never from the absence of evidence in a place we
did not finish looking. Three specific traps, each of which silently
double-refunds if missed:

**1. Absence on page one is not absence.** The reconciler may only conclude
`CONFIRMED_NOT_APPLIED` after pagination has run to exhaustion within that
pass. A partial walk that finds nothing yields `STILL_UNKNOWN`. The mock rail
paginates at 3 per page so the loop is genuinely exercised rather than
theoretically present.

**2. The rail is not read-your-writes.** A refund created moments ago can read
back absent. The first reconcile query waits `RECONCILE_MIN_DELAY_MS` (2000)
after the attempt. Without the delay, the most dangerous case — we just tried,
and we are asking immediately — is the one most likely to answer wrongly.

**3. Amount is not an identity.** Two ₹3,400 refunds against one payment are
indistinguishable by amount. Matching is on `receipt` and
`notes.interlock_sik`, which is why every outbound refund is stamped on the way
out. The stamp is not decoration; it is the only thing that makes
reconciliation possible at all.

A corollary that took a while to see: **duplicates are a presence claim and
absence is not.** A partial walk that finds two matching entities has
discovered something true and must report it, even though the same partial walk
may not conclude that nothing exists. Presence needs one witness; absence needs
the whole search.

## Consequences

Reconciliation is slower than it could be and sometimes returns "still don't
know" — which is a real answer, and `QUARANTINED` plus a human is the correct
resolution at this scale. Retry tuning, circuit breakers and dead-letter queues
are explicitly out of scope: they are ways of making a machine guess harder at
a question where guessing is the failure.
