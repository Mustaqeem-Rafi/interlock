# Interlock — repo context for Claude Code

## What this is

An MCP proxy that sits between an AI agent and a payment API so the agent **cannot pay twice, and cannot pay more than it was authorised to**. Every tool call becomes a *proposed action* that must earn a decision before it reaches the rail.

Interlock was the Razorpay AI Buildathon Track 01 entry, shipped as interlock-mcp@0.2.0, and is now an open-source product; work follows [ROADMAP.md](ROADMAP.md).

## The one guarantee everything serves

> **The only edge into a rail call is `AUTHORIZED → IN_FLIGHT`, and after the first attempt the only edge into `AUTHORIZED` is from `CONFIRMED_NOT_APPLIED`.**

If a change makes that sentence untrue, the change is wrong.

## Non-negotiable invariants — assert these in code, test each one

- **I1** At most one intent per `(merchant_id, sik)`. Enforced by a PRIMARY KEY, not by a lock.
- **I2** No rail call is issued unless a durable `IN_FLIGHT` row exists on disk first. `PRAGMA synchronous = FULL`.
- **I3** A retry is issued **only** from `CONFIRMED_NOT_APPLIED`. A timeout or 5xx never retries — it reconciles.
- **I4** `APPLIED` and `BLOCKED` are absorbing.
- **I5** `attempt_seq` strictly monotone per intent.
- **I6** Every state change appends exactly one audit record; `seq` is gapless.

Three reconciler traps that must be handled, each of which silently double-refunds if missed:

1. **Absence on page one is not absence.** `CONFIRMED_NOT_APPLIED` is reachable only after pagination runs to exhaustion in that pass. Anything else is `STILL_UNKNOWN`.
2. **No read-your-writes.** Wait `RECONCILE_MIN_DELAY_MS` (2000) before the first reconcile query.
3. **Amount is not an identity.** Match on `receipt` / `notes.interlock_sik`, which is why we stamp them on the way out.

## Semantic idempotency key

```
sik = base32(sha256(canonicalJson({
  v: 1, merchant_id, tool, subject,     // subject = the RAIL entity id, resolved by us
  amount_minor, currency, extra, window, distinct
}))).slice(0, 32)
```

- `subject` is never the model's phrasing — it is the id we resolved ourselves from the rail.
- `create_refund` uses **no time window**. Two refunds of the same amount on the same payment are indistinguishable by meaning; refusing the second is correct. The escape hatch is an explicit `interlock_distinct_reason` from the agent, which enters the key and is recorded verbatim.
- Stamp `receipt = "ilk_" + sik` and `notes.interlock_sik = sik` on every refund. Razorpay treats `receipt` as a per-payment idempotency key, and the stamp is what makes reconciliation possible at all.

## Razorpay facts, verified — do not re-derive

- `create_refund` takes exactly `amount`, `speed`, `notes`, `receipt`. **No destination field.** A refund cannot be redirected.
- Money-out surface of the Razorpay MCP server is essentially `create_refund` and `create_instant_settlement`. Payouts are read-only there (`fetch_all_payouts`, `fetch_payout_by_id`; no `create_payout`).
- Reconciliation query for refunds: `fetch_multiple_refunds_for_payment`, paginated.
- Never hardcode a fee rate. Read `fees` / `tax` from the response.

## Stack and conventions

Node 22, TypeScript, pnpm workspaces, Zod at every boundary, `better-sqlite3` (synchronous — that is why it was chosen; the write must provably precede the network call), `@modelcontextprotocol/sdk` on both MCP directions.

- Money is always an **integer in minor units**. Floats are rejected at the boundary. No `number` for rupees anywhere.
- Timestamps are epoch ms integers.
- Layered: transport → gate/service → store. No SQL in the gate logic, no policy in the transport.
- Typed errors, never bare `Error`. Client shape is always `{success:false, error:{code, message, requestId}}`.
- Named exports. No default exports.
- Conventional commits.

## Layout

```
packages/
  core/src/     canonical.ts, hash.ts, sik.ts, env.ts, errors.ts, index.ts
    schemas/    action.ts, decision.ts, intent.ts, mandate.ts, primitives.ts, index.ts  (Zod)
  store/
    schema.sql
    src/        db.ts, intents.ts, audit.ts, chain.ts, decisions.ts, recon.ts, errors.ts, index.ts  (better-sqlite3)
  gate/src/
    proxy/      engine.ts, server.ts, upstream.ts, manifest.ts, responses.ts, index.ts  (MCP server in + MCP client out)
    gates/      g1_scope.ts, g2_value.ts, g3_limits.ts, g6_provenance.ts, ladder.ts, resolver.ts, index.ts
    exactly-once/  wal.ts, machine.ts, propose.ts, reconciler.ts, recovery.ts, sweep.ts, index.ts
    rail/       rail.ts (interface), mock.ts, razorpay.ts, errors.ts, index.ts
    api/        server.ts, routes.ts, console-api.ts, operations.ts, auth.ts, readiness.ts, stream.ts  (http surface + SSE)
    bin/        interlock-mcp.ts, interlock-console.ts, interlock-init.ts
    init/       author.ts, cli.ts, questions.ts
    kill-points.ts, index.ts
  chaos/src/    child.ts, matrix.ts, rail-state.ts, results.ts, verdict.ts, errors.ts, index.ts  (fault-injecting rail + kill-point matrix runner)
  bench/src/    runner.ts, scoring.ts, report.ts, world.ts, policy.ts, model.ts, cache.ts, catalogue.ts, cli.ts, types.ts, index.ts  (scenario runner, naive harness)
    harness/    naive.ts, langgraph.ts
    scenarios/  family-a.ts … family-e.ts, index.ts
```

## The model's place — enforce it in the type system

The money path is **100% deterministic**. There is no model in the decision path at all. The mandate is a machine-checkable file a human approves.

If a model gate is ever added, its return type must be `verdict: 'HOLD' | 'BLOCK'` — the union does not contain `ALLOW`, so it *cannot* express an upgrade. That is a type, not a prompt. The ladder additionally throws `InvariantViolation` on any attempted upgrade.

## Current scope

Work follows [ROADMAP.md](ROADMAP.md) phase by phase. The current phase is the `careful` baseline, then P0. The sequencing rules in ROADMAP.md are binding. The hackathon cut order no longer applies.

**Gate 5 (the LLM purpose judge) is opt-in and OFF by default**, behind `--purpose-check`, advisory, and typed so its verdict union cannot contain `ALLOW`. That is a design decision recorded in ADR-0005, not a time cut: with it off, the money path is provably deterministic end to end, which is the claim.

**Out of scope entirely:** multi-tenancy, retry tuning / circuit breakers / dead-letter queues (`QUARANTINED` plus a human is the correct answer at this scale), a landing page beyond a README.

## Testing

Every invariant above gets a test. The chaos matrix (5 kill points × N trials, asserting the rail entity count) is the headline result and must run from one command: `pnpm chaos:matrix`.

The mock rail's `ambiguous_504` must **apply the effect upstream and then drop the response**. A mock that 504s without applying has reproduced a failure, not the bug.
