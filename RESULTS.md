# Chaos matrix results

Five kill points, 20 trials each, 100 trials total.

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

| Kill point | Trials | Expected | Observed | Violations |
| --- | --- | --- | --- | --- |
| `before_wal` | 20 | 0 refunds, nothing attempted | 0 refunds ×20<br>AUTHORIZED ×20 | 0 |
| `after_wal_before_call` | 20 | 0 refunds, CONFIRMED_NOT_APPLIED | 0 refunds ×20<br>CONFIRMED_NOT_APPLIED ×20 | 0 |
| `during_call` | 20 | 0 refunds, CONFIRMED_NOT_APPLIED | 0 refunds ×20<br>CONFIRMED_NOT_APPLIED ×20 | 0 |
| `after_call_before_commit` | 20 | 1 refund, APPLIED | 1 refund ×20<br>APPLIED ×20 | 0 |
| `after_commit_before_ack` | 20 | 1 refund, APPLIED | 1 refund ×20<br>APPLIED ×20 | 0 |

| **Total** | **100** | | | **0** |

All 100 of 100 issuing processes were confirmed killed before
completing. That check is a violation in its own right, because a SIGKILL that
silently failed to land would leave every other assertion passing on a trial
that exercised nothing.

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

Run it with `pnpm chaos:matrix --trials 20`.

Started 2026-09-05T07:07:29.260Z, took 179s.
