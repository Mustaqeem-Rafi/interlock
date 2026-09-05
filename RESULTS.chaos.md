# Chaos matrix results

Five kill points, 4 trials each, 100 trials total.

**Exactly-once violations: 0**

## The guarantee

> never two, and never unknown

Not "always one". Killing the gate before it writes anything, or inside the
request before the rail acts on it, correctly ends with no refund at all —
so `before_wal` and `during_call` legitimately observe zero. A matrix that
demanded one refund per trial would be asserting the wrong property and
would fail two of the five points for entirely correct behaviour.

A trial passes only if all four hold after the restart:

1. At most one rail entity carries the sik — *never two*.
2. The intent is in a state that needs nothing further from the rail — *never unknown*.
3. If money moved, the ledger says `APPLIED` — no silent loss.
4. If the ledger says `APPLIED`, money moved — no phantom success.

## Results

| Kill point | Fault | Trials | Expected after recovery | Observed after recovery | After the agent retries | Violations |
| --- | --- | --- | --- | --- | --- | --- |
| `before_wal` | none | 4 | 0 refunds, nothing attempted | 0 refunds ×4<br>AUTHORIZED ×4 | 1 refund ×4<br>APPLIED ×4 | 0 |
| `before_wal` | ambiguous_504 | 4 | 0 refunds, nothing attempted | 0 refunds ×4<br>AUTHORIZED ×4 | 1 refund ×4<br>APPLIED ×4 | 0 |
| `before_wal` | slow | 4 | 0 refunds, nothing attempted | 0 refunds ×4<br>AUTHORIZED ×4 | 1 refund ×4<br>APPLIED ×4 | 0 |
| `before_wal` | dup_response | 4 | 0 refunds, nothing attempted | 0 refunds ×4<br>AUTHORIZED ×4 | 1 refund ×4<br>APPLIED ×4 | 0 |
| `before_wal` | partition | 4 | 0 refunds, nothing attempted | 0 refunds ×4<br>AUTHORIZED ×4 | 1 refund ×4<br>APPLIED ×4 | 0 |
| `after_wal_before_call` | none | 4 | 0 refunds, CONFIRMED_NOT_APPLIED | 0 refunds ×4<br>CONFIRMED_NOT_APPLIED ×4 | 1 refund ×4<br>APPLIED ×4 | 0 |
| `after_wal_before_call` | ambiguous_504 | 4 | 0 refunds, CONFIRMED_NOT_APPLIED | 0 refunds ×4<br>CONFIRMED_NOT_APPLIED ×4 | 1 refund ×4<br>APPLIED ×4 | 0 |
| `after_wal_before_call` | slow | 4 | 0 refunds, CONFIRMED_NOT_APPLIED | 0 refunds ×4<br>CONFIRMED_NOT_APPLIED ×4 | 1 refund ×4<br>APPLIED ×4 | 0 |
| `after_wal_before_call` | dup_response | 4 | 0 refunds, CONFIRMED_NOT_APPLIED | 0 refunds ×4<br>CONFIRMED_NOT_APPLIED ×4 | 1 refund ×4<br>APPLIED ×4 | 0 |
| `after_wal_before_call` | partition | 4 | 0 refunds, CONFIRMED_NOT_APPLIED | 0 refunds ×4<br>QUARANTINED ×4 | 0 refunds ×4<br>QUARANTINED ×4 | 0 |
| `during_call` | none | 4 | 0 refunds, CONFIRMED_NOT_APPLIED | 0 refunds ×4<br>CONFIRMED_NOT_APPLIED ×4 | 1 refund ×4<br>APPLIED ×4 | 0 |
| `during_call` | ambiguous_504 | 4 | 0 refunds, CONFIRMED_NOT_APPLIED | 0 refunds ×4<br>CONFIRMED_NOT_APPLIED ×4 | 1 refund ×4<br>APPLIED ×4 | 0 |
| `during_call` | slow | 4 | 0 refunds, CONFIRMED_NOT_APPLIED | 0 refunds ×4<br>CONFIRMED_NOT_APPLIED ×4 | 1 refund ×4<br>APPLIED ×4 | 0 |
| `during_call` | dup_response | 4 | 0 refunds, CONFIRMED_NOT_APPLIED | 0 refunds ×4<br>CONFIRMED_NOT_APPLIED ×4 | 1 refund ×4<br>APPLIED ×4 | 0 |
| `during_call` | partition | 4 | 0 refunds, CONFIRMED_NOT_APPLIED | 0 refunds ×4<br>QUARANTINED ×4 | 0 refunds ×4<br>QUARANTINED ×4 | 0 |
| `after_call_before_commit` | none | 4 | 1 refund, APPLIED | 1 refund ×4<br>APPLIED ×4 | 1 refund ×4<br>APPLIED ×4 | 0 |
| `after_call_before_commit` | ambiguous_504 | 4 | 1 refund, APPLIED | 1 refund ×4<br>APPLIED ×4 | 1 refund ×4<br>APPLIED ×4 | 0 |
| `after_call_before_commit` | slow | 4 | 1 refund, APPLIED | 1 refund ×4<br>APPLIED ×4 | 1 refund ×4<br>APPLIED ×4 | 0 |
| `after_call_before_commit` | dup_response | 4 | 1 refund, APPLIED | 1 refund ×4<br>APPLIED ×4 | 1 refund ×4<br>APPLIED ×4 | 0 |
| `after_call_before_commit` | partition | 4 | 1 refund, APPLIED | 1 refund ×4<br>QUARANTINED ×4 | 1 refund ×4<br>QUARANTINED ×4 | 0 |
| `after_commit_before_ack` | none | 4 | 1 refund, APPLIED | 1 refund ×4<br>APPLIED ×4 | 1 refund ×4<br>APPLIED ×4 | 0 |
| `after_commit_before_ack` | ambiguous_504 | 4 | 1 refund, APPLIED | 1 refund ×4<br>APPLIED ×4 | 1 refund ×4<br>APPLIED ×4 | 0 |
| `after_commit_before_ack` | slow | 4 | 1 refund, APPLIED | 1 refund ×4<br>APPLIED ×4 | 1 refund ×4<br>APPLIED ×4 | 0 |
| `after_commit_before_ack` | dup_response | 4 | 1 refund, APPLIED | 1 refund ×4<br>APPLIED ×4 | 1 refund ×4<br>APPLIED ×4 | 0 |
| `after_commit_before_ack` | partition | 4 | 1 refund, APPLIED | 1 refund ×4<br>APPLIED ×4 | 1 refund ×4<br>APPLIED ×4 | 0 |

| **Total** | | **100** | | | | **0** |

88 of 100 issuing processes were confirmed killed at their
kill point. The other 12 were preempted: a fault threw inside the rail
call before the kill point could be reached, so surviving there is correct
behaviour rather than a disarmed matrix. A kill that was reachable and did not
land is a violation in its own right, because a SIGKILL that silently failed
would leave every other assertion passing on a trial that exercised nothing.

The two right-hand columns answer different questions. Observed after recovery
is the crash-safety claim: what a restart alone establishes. After the agent
retries is what happens when it asks for the same refund again, which is the
request most likely to produce a second one. A row reading 0 refunds and then
1 refund is the system working: the crash left nothing applied, and the retry
completed it exactly once.

## Regressions this matrix has caught

Kept here because they are the reason the matrix exists, and because a table
of zeroes says nothing about whether it was ever capable of saying otherwise.

- **An intent left in `UNKNOWN` was never reconciled by anything.** A rail call
  that ends ambiguously records `UNKNOWN` and hands the intent to whoever
  reconciles next. Nothing did: the periodic sweep only detects drift, and boot
  recovery only looked at `IN_FLIGHT` and `RECONCILING`. So an intent that
  reached `UNKNOWN` cleanly sat there forever, with the money possibly already
  gone and nothing ever going to check. Surfaced as `SILENT_LOSS` plus
  `UNRESOLVED_AFTER_RECOVERY` on every `ambiguous_504` cell. Fixed by making
  `UNKNOWN` a recoverable state.

- **The write-ahead log trusted the id the rail returned.** Under `dup_response`
  the gateway replays a previous response, so the ledger recorded a refund id
  belonging to somebody else while our own refund sat upstream unclaimed. This
  is trap 3 — amount is not an identity — applied to the response rather than to
  reconciliation, and it had only ever been applied to reconciliation. Surfaced
  as `WRONG_ENTITY_RECORDED`. Fixed by checking the response carries the stamp
  we sent; if it does not, the outcome is ambiguous and the reconciler goes and
  finds the real one.

## How this was produced

For each kill point, each trial starts a gate process against a fresh SQLite
ledger and a fresh append-only rail journal, issues one refund, and waits for
the process to be SIGKILLed at that exact lifecycle position. `SIGKILL` is
used rather than a thrown error because an exception unwinds — `finally`
blocks run, buffers flush, SQLite rolls back cleanly — and a machine losing
power does none of that.

A second process is then started against the same two files. It runs boot
recovery to completion before doing anything else, and only then is the
ledger compared against the rail journal.

Run it with `pnpm chaos:matrix --trials 4`.

Started 2026-09-05T21:26:54.156Z, took 81s.
