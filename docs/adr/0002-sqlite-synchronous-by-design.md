# ADR-0002 — A synchronous driver, because the write must provably precede the call

**Status:** accepted · **Date:** 2026-09-03

## Context

Invariant I2 says no rail call is issued unless a durable `IN_FLIGHT` row
exists on disk first. Everything else in the engine depends on it. If the
process dies between the rail call and the record of it, recovery must be able
to find an intent that says "I was about to move money" — otherwise the money
moves and nothing remembers, and the next attempt moves it again.

"Durable" is doing real work in that sentence. It does not mean "we called
`INSERT`". It means the bytes reached the disk before the network packet left.

## Decision

`better-sqlite3`, opened with `PRAGMA journal_mode = WAL` and
`PRAGMA synchronous = FULL`, asserted at open time.

The driver is synchronous, and that is the reason it was chosen rather than a
property to apologise for. With an async driver, "write then call" is a promise
chain, and a promise chain is a thing a future refactor can reorder, race, or
accidentally fire in parallel. With a synchronous driver, the statement after
the write cannot execute until the write has returned. The ordering is enforced
by the language rather than by everyone remembering.

`synchronous = FULL` is not a conservative default to be traded away for
throughput later. Under `NORMAL` in WAL mode SQLite does not fsync on every
commit; it lets the OS flush when it likes. The commit returns before the bytes
are safe. Issue the rail call in that window, lose power, and on restart the
intent looks untried — so the engine retries it and the customer is refunded
twice. That is exactly the bug this project exists to prevent, and it is
invisible in testing because it needs a real crash to show up.

The pragmas are re-read after being set and the store refuses to open if they
did not take.

## Consequences

One fsync per commit. We commit once per state transition, not once per
request, so this is not the bottleneck; the measured p50 added latency is
single-digit milliseconds. If it ever does become the bottleneck the answer is
fewer transitions, never a weaker pragma.

Being a native addon, `better-sqlite3` needs a prebuild for the running Node
ABI. This is the single most common way a fresh environment fails, so the
published package keeps it external and declared, and the test suite probes it
by opening a real ledger rather than inferring from something cheaper.

We are single-process and single-tenant as a result. Postgres would buy
concurrency we do not need and would replace a filesystem fsync we can reason
about with a network round trip we cannot. At this scale that is a worse trade.
