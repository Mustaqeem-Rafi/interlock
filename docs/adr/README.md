# Architecture decision records

Five decisions that the rest of the code assumes. Each says what was chosen,
what it cost, and what it gives up — a record with no consequences section is an
advertisement.

| | | |
| --- | --- | --- |
| [0001](0001-semantic-idempotency-key.md) | Identity comes from meaning, not from a token the caller invents | why a model's retry is not the same problem as a network's |
| [0002](0002-sqlite-synchronous-by-design.md) | A synchronous driver, because the write must provably precede the call | why `synchronous = FULL` is the guarantee and not a tuning knob |
| [0003](0003-absence-is-not-absence.md) | The reconciler may only claim absence it has actually established | the three traps, each of which silently double-refunds |
| [0004](0004-what-broke-and-how-i-got-out.md) | What broke, and how I got out | the first chaos matrix passed, and it was wrong to |
| [0005](0005-gate-5-is-off-by-default.md) | The purpose gate is opt-in, advisory, and cannot say yes | why `ALLOW` is not in the union |
