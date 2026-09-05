# ADR-0004 — What broke, and how I got out

**Status:** accepted · **Date:** 2026-09-04

Not a decision record so much as an account of one. It is here because the
honest story is not "the chaos matrix passed". It is that the **first version of
the matrix passed, and it was wrong to** — and that finding out cost less than
shipping would have.

## The matrix that proved nothing

The first matrix was green. It was green because it never asked a hard
question: one refund, no rail faults, and the agent never retried after the
restart. It confirmed that a process killed mid-refund does not double-refund
*when nothing else is going wrong*, which is the easy half of the problem.

Widened along three axes — 5 kill points × 5 fault profiles, plus a second
phase where the agent asks for the same refund again after recovery — it went
from green to **34 violations in a single run**. Then 8. Then 0.

## The two that were real

**An intent left in `UNKNOWN` was never reconciled by anything.**

This is the serious one. A rail call that ends ambiguously records `UNKNOWN` and
hands the intent to whoever reconciles next — and nothing did. The 60-second
sweep only detected drift. Boot recovery only looked at `IN_FLIGHT` and
`RECONCILING`. So an intent that reached `UNKNOWN` cleanly sat there
permanently, money possibly already gone, with nothing ever going to check.

It needed **no crash at all** to reproduce. A plain 504 was enough. It hid
because every earlier test drove `reconciler.settle()` by hand, so nothing in
the system had ever been asked to do it on its own outside a restart. That is
the lesson worth keeping: a test that calls the thing under test directly
cannot discover that nobody else calls it.

Surfaced as `SILENT_LOSS` + `UNRESOLVED_AFTER_RECOVERY` on every
`ambiguous_504` cell. `UNKNOWN` is now a recoverable state.

**The write-ahead log trusted the id the rail returned.**

Under the `dup_response` fault the gateway replays a previous response body. The
ledger recorded a refund id belonging to *someone else's* refund while our own
sat upstream unclaimed. This is trap 3 — amount is not an identity — applied to
the response rather than to reconciliation, and I had only ever applied it to
reconciliation. The response must now carry the stamp we sent; if it does not,
the outcome is ambiguous, no id is recorded, and the reconciler goes and finds
the real one.

Both have unit tests, and both tests were confirmed to fail when the fix is
reverted. A regression test that has never been seen to fail is a guess.

## The three that were mine

Not system failures, but each would have produced a misleading result — which
is worse than a failure, because it looks like a pass:

- The retry child returned an unawaited promise inside a `try`, so
  `store.close()` fired first: "database is not open".
- The `dup_response` decoy call was itself armed with the kill point and
  swallowed the kill, so those trials tested the harness rather than the system.
- A retry that created a fresh intent never drove it through the gates, so it
  sat at `PROPOSED` forever.

I also moved `killAt('after_call_before_commit')` above the new response check.
Otherwise a bad response makes that kill point unreachable, silently costing
coverage — a green cell that never ran.

## Where it ended

- 25 cells × 4 trials × 2 phases = 200 observations, 0 exactly-once violations
- 100 trials at the acceptance count, 0 violations, 100/100 processes confirmed
  killed at their kill point rather than surviving
- The table separates *after recovery* from *after the agent retries*. Read in
  one column, correct behaviour looked like drift: `before_wal` legitimately
  shows 0 refunds after recovery and 1 after the retry. That is the system
  working — the crash left nothing applied, and the retry completed it exactly
  once.

`RESULTS.md` carries a standing **"regressions this matrix has caught"**
section. A table of zeroes says nothing about whether the thing was ever capable
of saying otherwise, and the two bugs above are the evidence that it was.

## What I would tell the next person

Three things.

The guarantee is **"never two, and never unknown"** — deliberately not "always
one". Killing the gate before it writes anything correctly ends with no refund
at all. A matrix that asserted "always one" would have to be wrong somewhere to
pass, and the place it was wrong would be the safety property.

Widen the harness before trusting it. Every real bug here was found by making
the test harder, and none by making the code prettier.

And treat a passing suite as a claim about the suite, not about the system,
until you have watched it fail.
